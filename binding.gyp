{
  "targets": [
    {
      "target_name": "safe_publish",
      "sources": ["src/native/safe_publish.c"],
      "cflags": ["-Wall", "-Wextra", "-Werror"],
      "xcode_settings": {
        "OTHER_CFLAGS": ["-Wall", "-Wextra", "-Werror", "-Wno-unused-parameter"],
        "MACOSX_DEPLOYMENT_TARGET": "12.0"
      }
    }
  ]
}
