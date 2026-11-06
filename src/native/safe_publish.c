// safe_publish: the only code in the app that writes into a project folder.
//
// It implements exactly the F3 publication rules of the plan (revision 7):
//   - folders are opened as handles, one path component at a time, never
//     following a symlink (O_DIRECTORY | O_NOFOLLOW; the root with
//     O_NOFOLLOW_ANY where the OS has it), and each is checked to be a folder;
//   - every later operation is relative to those handles (openat, linkat,
//     unlinkat), so replacing a folder path after the check cannot redirect it;
//   - a record is written to a new temporary file (exclusive create), flushed,
//     then published with a hard link that fails if the name exists;
//   - there is no rename and no overwrite.
//
// Deleting is limited to the app's own ".tmp-" files, and to removing the old
// name of a file only after the very same file (same device and inode) is
// already present in quarantine.
//
// Names are single path components chosen by the app. "", ".", "..", and any
// name containing "/" or NUL are refused.

#define NAPI_VERSION 8
#include <node_api.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#define MAX_NAME 255
#define MAX_PATH_LEN 4096

static const char *errno_code(int e) {
  switch (e) {
    case EEXIST: return "EEXIST";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case ELOOP: return "ELOOP";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case ENOSPC: return "ENOSPC";
    case EDQUOT: return "EDQUOT";
    case EROFS: return "EROFS";
    case EIO: return "EIO";
    case EISDIR: return "EISDIR";
    case EINVAL: return "EINVAL";
    case EBADF: return "EBADF";
    case EMLINK: return "EMLINK";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case EXDEV: return "EXDEV";
    default: return "EUNKNOWN";
  }
}

static napi_value throw_errno(napi_env env, const char *op, const char *subject, int e) {
  char msg[MAX_PATH_LEN + 256];
  snprintf(msg, sizeof msg, "%s: %s failed for %s (%s)", errno_code(e), op, subject ? subject : "", strerror(e));
  napi_throw_error(env, errno_code(e), msg);
  return NULL;
}

static napi_value throw_code(napi_env env, const char *code, const char *msg) {
  napi_throw_error(env, code, msg);
  return NULL;
}

static int get_string(napi_env env, napi_value v, char *buf, size_t cap, size_t *len_out) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) return 0;
  if (len + 1 > cap) return 0;
  if (napi_get_value_string_utf8(env, v, buf, cap, &len) != napi_ok) return 0;
  if (strlen(buf) != len) return 0; // embedded NUL
  if (len_out) *len_out = len;
  return 1;
}

static int valid_name(const char *s) {
  size_t n = strlen(s);
  if (n == 0 || n > MAX_NAME) return 0;
  if (strcmp(s, ".") == 0 || strcmp(s, "..") == 0) return 0;
  if (strchr(s, '/') != NULL) return 0;
  return 1;
}

static int get_name(napi_env env, napi_value v, char *buf) {
  return get_string(env, v, buf, MAX_NAME + 2, NULL) && valid_name(buf);
}

static int get_fd(napi_env env, napi_value v, int *fd) {
  int32_t x;
  if (napi_get_value_int32(env, v, &x) != napi_ok || x < 0) return 0;
  *fd = (int)x;
  return 1;
}

static int sync_fd(int fd, int full) {
#ifdef F_FULLFSYNC
  if (full && fcntl(fd, F_FULLFSYNC) == 0) return 0;
#else
  (void)full;
#endif
  return fsync(fd);
}

static int check_dir(int fd) {
  struct stat st;
  if (fstat(fd, &st) != 0) return errno;
  if (!S_ISDIR(st.st_mode)) return ENOTDIR;
  return 0;
}

static napi_value make_int(napi_env env, int x) {
  napi_value v;
  napi_create_int32(env, x, &v);
  return v;
}

static napi_value make_undefined(napi_env env) {
  napi_value v;
  napi_get_undefined(env, &v);
  return v;
}

// openDir(root: string, segments: string[], create: boolean): number
static napi_value OpenDir(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 3) return throw_code(env, "EINVAL", "EINVAL: openDir(root, segments, create)");
  char root[MAX_PATH_LEN];
  if (!get_string(env, argv[0], root, sizeof root, NULL) || root[0] != '/') return throw_code(env, "EINVAL", "EINVAL: root must be an absolute path");
  bool create = false;
  napi_get_value_bool(env, argv[2], &create);
  bool is_array = false;
  napi_is_array(env, argv[1], &is_array);
  if (!is_array) return throw_code(env, "EINVAL", "EINVAL: segments must be a list");
  uint32_t n = 0;
  napi_get_array_length(env, argv[1], &n);

  int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
#ifdef O_NOFOLLOW_ANY
  // Refuse a symlink in any component of the root path. O_NOFOLLOW_ANY already covers the last
  // component, and macOS rejects it combined with O_NOFOLLOW (EINVAL), so it replaces it here.
  int root_flags = (flags & ~O_NOFOLLOW) | O_NOFOLLOW_ANY;
#else
  int root_flags = flags;
#endif
  int fd = open(root, root_flags);
  if (fd < 0) return throw_errno(env, "open folder", root, errno);
  int e = check_dir(fd);
  if (e) {
    close(fd);
    return throw_errno(env, "check folder", root, e);
  }
  for (uint32_t i = 0; i < n; i++) {
    napi_value item;
    char seg[MAX_NAME + 2];
    napi_get_element(env, argv[1], i, &item);
    if (!get_name(env, item, seg)) {
      close(fd);
      return throw_code(env, "EINVAL", "EINVAL: invalid folder name");
    }
    int next = openat(fd, seg, flags);
    if (next < 0 && errno == ENOENT && create) {
      if (mkdirat(fd, seg, 0755) != 0 && errno != EEXIST) {
        int err = errno;
        close(fd);
        return throw_errno(env, "create folder", seg, err);
      }
      next = openat(fd, seg, flags);
    }
    if (next < 0) {
      int err = errno;
      close(fd);
      return throw_errno(env, "open folder", seg, err);
    }
    e = check_dir(next);
    close(fd);
    if (e) {
      close(next);
      return throw_errno(env, "check folder", seg, e);
    }
    fd = next;
  }
  return make_int(env, fd);
}

// closeDir(fd)
static napi_value CloseDir(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || !get_fd(env, argv[0], &fd)) return throw_code(env, "EINVAL", "EINVAL: closeDir(fd)");
  close(fd);
  return make_undefined(env);
}

// createExclusive(fd, name, data: Buffer, fullSync: boolean)
static napi_value CreateExclusive(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  int dfd;
  char name[MAX_NAME + 2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 4 || !get_fd(env, argv[0], &dfd) || !get_name(env, argv[1], name)) return throw_code(env, "EINVAL", "EINVAL: createExclusive(fd, name, data, fullSync)");
  void *data = NULL;
  size_t len = 0;
  bool is_buf = false;
  napi_is_buffer(env, argv[2], &is_buf);
  if (!is_buf || napi_get_buffer_info(env, argv[2], &data, &len) != napi_ok) return throw_code(env, "EINVAL", "EINVAL: data must be a Buffer");
  bool full = false;
  napi_get_value_bool(env, argv[3], &full);

  int fd = openat(dfd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0644);
  if (fd < 0) return throw_errno(env, "create file", name, errno);
  const char *p = (const char *)data;
  size_t left = len;
  while (left > 0) {
    ssize_t w = write(fd, p, left);
    if (w < 0) {
      if (errno == EINTR) continue;
      int err = errno;
      close(fd);
      unlinkat(dfd, name, 0); // our own new file; never anything else
      return throw_errno(env, "write file", name, err);
    }
    p += w;
    left -= (size_t)w;
  }
  if (sync_fd(fd, full) != 0) {
    int err = errno;
    close(fd);
    unlinkat(dfd, name, 0);
    return throw_errno(env, "flush file", name, err);
  }
  if (close(fd) != 0) return throw_errno(env, "close file", name, errno);
  return make_undefined(env);
}

// linkNoReplace(fd, from, to): hard link inside one folder; fails with EEXIST if "to" exists.
static napi_value LinkNoReplace(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int dfd;
  char from[MAX_NAME + 2], to[MAX_NAME + 2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 3 || !get_fd(env, argv[0], &dfd) || !get_name(env, argv[1], from) || !get_name(env, argv[2], to)) return throw_code(env, "EINVAL", "EINVAL: linkNoReplace(fd, from, to)");
  if (linkat(dfd, from, dfd, to, 0) != 0) return throw_errno(env, "link", to, errno);
  return make_undefined(env);
}

// linkInto(srcFd, name, destFd, destName): hard link across two folder handles (for quarantine); never replaces.
static napi_value LinkInto(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  int sfd, dfd;
  char name[MAX_NAME + 2], dest[MAX_NAME + 2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 4 || !get_fd(env, argv[0], &sfd) || !get_name(env, argv[1], name) || !get_fd(env, argv[2], &dfd) || !get_name(env, argv[3], dest))
    return throw_code(env, "EINVAL", "EINVAL: linkInto(srcFd, name, destFd, destName)");
  if (linkat(sfd, name, dfd, dest, 0) != 0) return throw_errno(env, "link into quarantine", dest, errno);
  return make_undefined(env);
}

// removeTemp(fd, name): only the app's own ".tmp-" files.
static napi_value RemoveTemp(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int dfd;
  char name[MAX_NAME + 2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2 || !get_fd(env, argv[0], &dfd) || !get_name(env, argv[1], name)) return throw_code(env, "EINVAL", "EINVAL: removeTemp(fd, name)");
  if (strncmp(name, ".tmp-", 5) != 0) return throw_code(env, "EPERM", "EPERM: removeTemp only removes the app's own .tmp- files");
  struct stat st;
  if (fstatat(dfd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) return throw_errno(env, "check file", name, errno);
  if (!S_ISREG(st.st_mode)) return throw_code(env, "EPERM", "EPERM: removeTemp only removes regular files");
  if (unlinkat(dfd, name, 0) != 0) return throw_errno(env, "remove temporary file", name, errno);
  return make_undefined(env);
}

// removeQuarantined(srcFd, name, qFd, qName): remove the old name only if the very same file is in quarantine.
static napi_value RemoveQuarantined(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  int sfd, qfd;
  char name[MAX_NAME + 2], qname[MAX_NAME + 2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 4 || !get_fd(env, argv[0], &sfd) || !get_name(env, argv[1], name) || !get_fd(env, argv[2], &qfd) || !get_name(env, argv[3], qname))
    return throw_code(env, "EINVAL", "EINVAL: removeQuarantined(srcFd, name, qFd, qName)");
  struct stat a, b;
  if (fstatat(sfd, name, &a, AT_SYMLINK_NOFOLLOW) != 0) return throw_errno(env, "check file", name, errno);
  if (fstatat(qfd, qname, &b, AT_SYMLINK_NOFOLLOW) != 0) return throw_errno(env, "check quarantine copy", qname, errno);
  if (!S_ISREG(a.st_mode) || !S_ISREG(b.st_mode) || a.st_dev != b.st_dev || a.st_ino != b.st_ino)
    return throw_code(env, "EPERM", "EPERM: the quarantine copy is not the same file; nothing removed");
  if (unlinkat(sfd, name, 0) != 0) return throw_errno(env, "remove old name", name, errno);
  return make_undefined(env);
}

// fsyncDir(fd, fullSync)
static napi_value FsyncDir(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  int fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2 || !get_fd(env, argv[0], &fd)) return throw_code(env, "EINVAL", "EINVAL: fsyncDir(fd, fullSync)");
  bool full = false;
  napi_get_value_bool(env, argv[1], &full);
  if (sync_fd(fd, full) != 0) return throw_errno(env, "flush folder", "", errno);
  return make_undefined(env);
}

// readFile(fd, name, maxBytes): Buffer | null. Regular files only; never follows a symlink.
static napi_value ReadFile(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int dfd;
  char name[MAX_NAME + 2];
  int32_t max = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 3 || !get_fd(env, argv[0], &dfd) || !get_name(env, argv[1], name) || napi_get_value_int32(env, argv[2], &max) != napi_ok || max <= 0)
    return throw_code(env, "EINVAL", "EINVAL: readFile(fd, name, maxBytes)");
  int fd = openat(dfd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT) {
      napi_value nul;
      napi_get_null(env, &nul);
      return nul;
    }
    return throw_errno(env, "open file", name, errno);
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    int err = errno;
    close(fd);
    return throw_errno(env, "check file", name, err);
  }
  if (!S_ISREG(st.st_mode)) {
    close(fd);
    return throw_code(env, "EINVAL", "EINVAL: not a regular file");
  }
  if (st.st_size > max) {
    close(fd);
    return throw_code(env, "EFBIG", "EFBIG: file larger than the limit");
  }
  size_t size = (size_t)st.st_size;
  char *buf = malloc(size ? size : 1);
  if (!buf) {
    close(fd);
    return throw_code(env, "ENOMEM", "ENOMEM: out of memory");
  }
  size_t got = 0;
  while (got < size) {
    ssize_t r = read(fd, buf + got, size - got);
    if (r < 0) {
      if (errno == EINTR) continue;
      int err = errno;
      free(buf);
      close(fd);
      return throw_errno(env, "read file", name, err);
    }
    if (r == 0) break;
    got += (size_t)r;
  }
  close(fd);
  napi_value out;
  napi_create_buffer_copy(env, got, buf, NULL, &out);
  free(buf);
  return out;
}

// listDir(fd): [{ name, kind: 'file' | 'dir' | 'other' }], never following symlinks.
static napi_value ListDir(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || !get_fd(env, argv[0], &fd)) return throw_code(env, "EINVAL", "EINVAL: listDir(fd)");
  int dupfd = dup(fd);
  if (dupfd < 0) return throw_errno(env, "list folder", "", errno);
  DIR *d = fdopendir(dupfd);
  if (!d) {
    int err = errno;
    close(dupfd);
    return throw_errno(env, "list folder", "", err);
  }
  rewinddir(d);
  napi_value arr;
  napi_create_array(env, &arr);
  uint32_t i = 0;
  struct dirent *ent;
  while ((ent = readdir(d)) != NULL) {
    if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
    struct stat st;
    const char *kind = "other";
    if (fstatat(fd, ent->d_name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
      if (S_ISREG(st.st_mode)) kind = "file";
      else if (S_ISDIR(st.st_mode)) kind = "dir";
    }
    napi_value obj, nm, kd;
    napi_create_object(env, &obj);
    napi_create_string_utf8(env, ent->d_name, NAPI_AUTO_LENGTH, &nm);
    napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &kd);
    napi_set_named_property(env, obj, "name", nm);
    napi_set_named_property(env, obj, "kind", kd);
    napi_set_element(env, arr, i++, obj);
  }
  closedir(d); // closes dupfd
  return arr;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"openDir", NULL, OpenDir, NULL, NULL, NULL, napi_enumerable, NULL},
    {"closeDir", NULL, CloseDir, NULL, NULL, NULL, napi_enumerable, NULL},
    {"createExclusive", NULL, CreateExclusive, NULL, NULL, NULL, napi_enumerable, NULL},
    {"linkNoReplace", NULL, LinkNoReplace, NULL, NULL, NULL, napi_enumerable, NULL},
    {"linkInto", NULL, LinkInto, NULL, NULL, NULL, napi_enumerable, NULL},
    {"removeTemp", NULL, RemoveTemp, NULL, NULL, NULL, napi_enumerable, NULL},
    {"removeQuarantined", NULL, RemoveQuarantined, NULL, NULL, NULL, napi_enumerable, NULL},
    {"fsyncDir", NULL, FsyncDir, NULL, NULL, NULL, napi_enumerable, NULL},
    {"readFile", NULL, ReadFile, NULL, NULL, NULL, napi_enumerable, NULL},
    {"listDir", NULL, ListDir, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
