// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { MOBILE_HOSTS } from "@/expo/plugins/withMobileBundle";

type BrittleAssert = {
  is: Function;
  ok: Function;
  alike: Function;
  exception: Function;
  absent: Function;
};

test("MOBILE_HOSTS: canonical mobile host set", (t: BrittleAssert) => {
  t.alike(MOBILE_HOSTS, [
    "android-arm64",
    "ios-arm64",
    "ios-arm64-simulator",
    "ios-x64-simulator",
  ]);
});
