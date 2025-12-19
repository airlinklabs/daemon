{
  "targets": [
    {
      "target_name": "rename_at",
      "sources": [ "rename_at.cc" ],

      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],

      "defines": [
        "NAPI_CPP_EXCEPTIONS"
      ],

      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "13.0"
          }
        }]
      ],

      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],

      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ]
    },

    {
      "target_name": "secure_open",
      "sources": [ "secure_open.cc" ],

      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],

      "defines": [
        "NAPI_CPP_EXCEPTIONS"
      ],

      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "13.0"
          }
        }]
      ],

      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],

      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ]
    }
  ]
}