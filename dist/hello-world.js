(function (mcloud) {
  'use strict';

  mcloud.plugins.registerPlugin({
    name: "Hello World",
    description: "Example Plugin",
    version: "1.0.0",
    website: "https://github.com/lideming/MusicCloud-example-plugins",
  });

  mcloud.Toast.show("Hello World Plugin is running", 3000);

})(mcloud);
