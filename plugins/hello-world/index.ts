import { plugins, Toast } from "@yuuza/mcloud";

plugins.registerPlugin({
  name: "Hello World",
  description: "Example Plugin",
  version: "1.0.0",
  website: "https://github.com/lideming/MusicCloud-example-plugins",
});

Toast.show("Hello World Plugin is running", 3000);
