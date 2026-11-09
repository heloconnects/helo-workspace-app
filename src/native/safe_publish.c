// safe_publish: the only code in the app that writes into a project folder.
//
// It implements the F3 publication rules of the plan (revision 9), with one
// approved change (Ahmed, 2026-11-07, after the Codex review of persistence v1):
// publication and quarantine use macOS's no-replace move, renameatx_np with
// RENAME_EXCL, instead of a hard link followed by removing the old name. The
// move is atomic and fails if the destination exists, so nothing is ever
// replaced, and the app never deletes anything: there is no unlink at all.
//
//   - The project root is opened once as a handle without following a symlink
//     anywhere in its path (O_NOFOLLOW_ANY). The caller checks that handle's
//     identity and RULES.md through it, then opens every folder below it
//     relative to that same handle, one component at a time (O_DIRECTORY |
//     O_NOFOLLOW), so the folder that was checked is the folder written to.
//   - A record is written to a new temporary file (O_CREAT | O_EXCL |
//     O_NOFOLLOW), flushed, then moved to its final name with RENAME_EXCL.
//     The source must be a regular file, and the moved entry is verified to be
//     the very file that was checked. macOS moves whatever holds the source
//     name, so a swap at that instant is detected, not prevented: the app
//     tries once to move the swapped-in entry back and reports whether it
//     could (see moveNoReplace; plan revision 9).
//   - Newly created folders, and folders whose entries change, are flushed.
//   - Files are read only after checking they are regular files, opened with
//     O_NONBLOCK so a FIFO or device put in place of a record cannot hang.
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

#ifndef RENAME_EXCL
#error "renameatx_np with RENAME_EXCL (macOS 10.12+) is required"
#endif

#ifdef RENAME_NOFOLLOW_ANY
#define MOVE_FLAGS (RENAME_EXCL | RENAME_NOFOLLOW_ANY)
#else
#define MOVE_FLAGS RENAME_EXCL
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
    case ENOTSUP: return "ENOTSUP";
    case EAGAIN: return "EAGAIN";
    case EBUSY: return "EBUSY";
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

static int get_string(napi_env env, napi_value v, char *buf, size_t cap) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) return 0;
  if (len + 1 > cap) return 0;
  if (napi_get_value_string_utf8(env, v, buf, cap, &len) != napi_ok) return 0;
  if (strlen(buf) != len) return 0; // embedded NUL
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
  return get_string(env, v, buf, MAX_NAME + 2) && valid_name(buf);
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

static const int DIR_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;

// openRoot(path: string): number. No symlink anywhere in the path.
static napi_value OpenRoot(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char root[MAX_PATH_LEN];
  if (argc < 1 || !get_string(env, argv[0], root, sizeof root) || root[0] != '/') return throw_code(env, "EINVAL", "EINVAL: root must be an absolute path");
#ifdef O_NOFOLLOW_ANY
  // O_NOFOLLOW_ANY covers every component; macOS rejects it combined with O_NOFOLLOW.
  int flags = (DIR_FLAGS & ~O_NOFOLLOW) | O_NOFOLLOW_ANY;
#else
  int flags = DIR_FLAGS;
#endif
  int fd = open(root, flags);
  if (fd < 0) return throw_errno(env, "open folder", root, errno);
  int e = check_dir(fd);
  if (e) {
    close(fd);
    return throw_errno(env, "check folder", root, e);
  }
  return make_int(env, fd);
}

// openSub(baseFd, segments: string[], create: boolean): number. A new handle; baseFd stays open.
static napi_value OpenSub(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int base;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 3 || !get_fd(env, argv[0], &base)) return throw_code(env, "EINVAL", "EINVAL: openSub(baseFd, segments, create)");
  bool create = false;
  napi_get_value_bool(env, argv[2], &create);
  bool is_array = false;
  napi_is_array(env, argv[1], &is_array);
  if (!is_array) return throw_code(env, "EINVAL", "EINVAL: segments must be a list");
  uint32_t n = 0;
  napi_get_array_length(env, argv[1], &n);
  int fd = dup(base);
  if (fd < 0) return throw_errno(env, "open folder", "", errno);
  for (uint32_t i = 0; i < n; i++) {
    napi_value item;
    char seg[MAX_NAME + 2];
    napi_get_element(env, argv[1], i, &item);
    if (!get_name(env, item, seg)) {
      close(fd);
      return throw_code(env, "EINVAL", "EINVAL: invalid folder name");
    }
    int next = openat(fd, seg, DIR_FLAGS);
    if (next < 0 && errno == ENOENT && create) {
      if (mkdirat(fd, seg, 0755) == 0) {
        // Make the new entry durable in its parent before going on.
        if (sync_fd(fd, 1) != 0) {
          int err = errno;
          close(fd);
          return throw_errno(env, "flush folder", seg, err);
        }
      } else if (errno != EEXIST) {
        int err = errno;
        close(fd);
        return throw_errno(env, "create folder", seg, err);
      }
      next = openat(fd, seg, DIR_FLAGS);
    }
    if (next < 0) {
      int err = errno;
      close(fd);
      return throw_errno(env, "open folder", seg, err);
    }
    int e = check_dir(next);
    close(fd);
    if (e) {
      close(next);
      return throw_errno(env, "check folder", seg, e);
    }
    fd = next;
  }
  return make_int(env, fd);
}

// identity(fd): "dev:ino" of an open folder.
static napi_value Identity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int fd;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || !get_fd(env, argv[0], &fd)) return throw_code(env, "EINVAL", "EINVAL: identity(fd)");
  struct stat st;
  if (fstat(fd, &st) != 0) return throw_errno(env, "check folder", "", errno);
  char buf[64];
  snprintf(buf, sizeof buf, "%llu:%llu", (unsigned long long)st.st_dev, (unsigned long long)st.st_ino);
  napi_value out;
  napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &out);
  return out;
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

// createExclusive(fd, name, data: Buffer, fullSync). On a write or flush failure the new file is
// left where it is (never deleted); recovery moves it to quarantine.
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
      return throw_errno(env, "write file", name, err);
    }
    p += w;
    left -= (size_t)w;
  }
  if (sync_fd(fd, full) != 0) {
    int err = errno;
    close(fd);
    return throw_errno(env, "flush file", name, err);
  }
  if (close(fd) != 0) return throw_errno(env, "close file", name, errno);
  return make_undefined(env);
}

// Test-only hook: when moveNoReplace is given a fifth argument (a function), it is called with
// "before-move" (after the source was opened and checked, just before the move) and, if a swap was
// detected, with "before-move-back". Tests use it to stage the swap race with ordinary file
// operations of their own. The app itself never passes it. Returns 0, or -1 if the hook threw.
static int call_hook(napi_env env, napi_value hook, const char *stage) {
  if (hook == NULL) return 0;
  napi_value global, arg, ignored;
  napi_get_global(env, &global);
  napi_create_string_utf8(env, stage, NAPI_AUTO_LENGTH, &arg);
  if (napi_call_function(env, global, hook, 1, &arg, &ignored) != napi_ok) return -1;
  return 0;
}

// moveNoReplace(srcFd, name, destFd, destName[, testHook]): atomic move that fails with EEXIST if
// destName exists (renameatx_np RENAME_EXCL). Nothing is replaced and nothing is deleted.
//
// Only a regular file is meant to be moved. The source is opened first (O_NOFOLLOW | O_NONBLOCK)
// and must be a regular file; that handle is held across the move, and after the move the entry
// now at destName must be that very file (same device and inode).
//
// The limit (plan revision 9, "Threat model and the move limit"): macOS moves whatever entry holds
// the source NAME at the moment of the move; it cannot move "only this exact file". If another
// entry (a folder, another file) is swapped in at the source name in between, it is moved. This is
// DETECTED afterwards, not prevented. The app then tries once to move that entry back, and reports
// one of two codes; in both cases nothing is published from this write:
//   ESWAPPED_MOVED_BACK      the swapped-in entry was moved back to the source name;
//   ESWAPPED_NOT_MOVED_BACK  moving it back failed; it may still be at the destination name.
// If the process is killed between the two moves, the swapped-in entry stays at the destination
// name. Nothing is deleted in any case.
//
// The move does not flush. The caller flushes both folders afterwards (fsyncDir), so a crash or a
// failed flush after a successful move can be told apart from a failed move.
static napi_value MoveNoReplace(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  int sfd, dfd;
  char name[MAX_NAME + 2], dest[MAX_NAME + 2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 4 || !get_fd(env, argv[0], &sfd) || !get_name(env, argv[1], name) || !get_fd(env, argv[2], &dfd) || !get_name(env, argv[3], dest))
    return throw_code(env, "EINVAL", "EINVAL: moveNoReplace(srcFd, name, destFd, destName)");
  napi_value hook = NULL;
  if (argc >= 5) {
    napi_valuetype t;
    if (napi_typeof(env, argv[4], &t) == napi_ok && t == napi_function) hook = argv[4];
  }
  int fd = openat(sfd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return throw_errno(env, "open file to move", name, errno);
  struct stat before;
  if (fstat(fd, &before) != 0) {
    int err = errno;
    close(fd);
    return throw_errno(env, "check file to move", name, err);
  }
  if (!S_ISREG(before.st_mode)) {
    close(fd);
    return throw_code(env, "EINVAL", "EINVAL: only regular files are moved");
  }
  if (call_hook(env, hook, "before-move") != 0) {
    close(fd);
    return NULL; // the hook's exception is pending
  }
  if (renameatx_np(sfd, name, dfd, dest, MOVE_FLAGS) != 0) {
    int err = errno;
    close(fd);
    return throw_errno(env, "move without replacing", dest, err);
  }
  struct stat after;
  int same = fstatat(dfd, dest, &after, AT_SYMLINK_NOFOLLOW) == 0 && after.st_dev == before.st_dev && after.st_ino == before.st_ino;
  close(fd);
  if (!same) {
    // Something else was swapped in at the source name and has been moved. Try once to move it
    // back. This is another move by name, so it can fail; nothing is ever deleted.
    if (call_hook(env, hook, "before-move-back") != 0) return NULL;
    if (renameatx_np(dfd, dest, sfd, name, MOVE_FLAGS) == 0) {
      return throw_code(env, "ESWAPPED_MOVED_BACK", "ESWAPPED_MOVED_BACK: something replaced the file while it was being saved; the entry that was swapped in was moved back to its original name; nothing was published");
    }
    return throw_code(env, "ESWAPPED_NOT_MOVED_BACK", "ESWAPPED_NOT_MOVED_BACK: something replaced the file while it was being saved; the entry that was swapped in could NOT be moved back and may still be at the record name; nothing was published, nothing was deleted");
  }
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

// readFile(fd, name, maxBytes): Buffer | null. Regular files only; never follows a symlink, never
// blocks on a FIFO or device (O_NONBLOCK on open, then the type is checked before any read).
static napi_value ReadFile(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  int dfd;
  char name[MAX_NAME + 2];
  int32_t max = 0;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 3 || !get_fd(env, argv[0], &dfd) || !get_name(env, argv[1], name) || napi_get_value_int32(env, argv[2], &max) != napi_ok || max <= 0)
    return throw_code(env, "EINVAL", "EINVAL: readFile(fd, name, maxBytes)");
  struct stat pre;
  if (fstatat(dfd, name, &pre, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) {
      napi_value nul;
      napi_get_null(env, &nul);
      return nul;
    }
    return throw_errno(env, "check file", name, errno);
  }
  if (!S_ISREG(pre.st_mode)) return throw_code(env, "EINVAL", "EINVAL: not a regular file");
  int fd = openat(dfd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
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
  int fl = fcntl(fd, F_GETFL);
  if (fl >= 0) fcntl(fd, F_SETFL, fl & ~O_NONBLOCK);
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
    {"openRoot", NULL, OpenRoot, NULL, NULL, NULL, napi_enumerable, NULL},
    {"openSub", NULL, OpenSub, NULL, NULL, NULL, napi_enumerable, NULL},
    {"identity", NULL, Identity, NULL, NULL, NULL, napi_enumerable, NULL},
    {"closeDir", NULL, CloseDir, NULL, NULL, NULL, napi_enumerable, NULL},
    {"createExclusive", NULL, CreateExclusive, NULL, NULL, NULL, napi_enumerable, NULL},
    {"moveNoReplace", NULL, MoveNoReplace, NULL, NULL, NULL, napi_enumerable, NULL},
    {"fsyncDir", NULL, FsyncDir, NULL, NULL, NULL, napi_enumerable, NULL},
    {"readFile", NULL, ReadFile, NULL, NULL, NULL, napi_enumerable, NULL},
    {"listDir", NULL, ListDir, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
