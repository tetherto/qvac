// @ts-expect-error brittle has no type declarations
import test from "brittle";
import * as withMobileBundle from "@/expo/plugins/withMobileBundle";
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

test("withMobileBundle: does not export CLI shell-out helpers", (t: BrittleAssert) => {
  t.absent("resolveCliCommand" in withMobileBundle);
  t.absent("buildVerifyBundleCommand" in withMobileBundle);
});
