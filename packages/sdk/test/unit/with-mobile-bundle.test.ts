import test from "brittle";
import { MOBILE_HOSTS } from "@/expo/plugins/withMobileBundle";

test("MOBILE_HOSTS: canonical mobile host set", (t) => {
  t.alike(MOBILE_HOSTS, [
    "android-arm64",
    "ios-arm64",
    "ios-arm64-simulator",
    "ios-x64-simulator",
  ]);
});
