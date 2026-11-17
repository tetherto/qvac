// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "QvacSDK",
  platforms: [.iOS(.v15), .macOS(.v13)],
  products: [
    .library(name: "QvacSDK", targets: ["QvacSDK"]),
    .library(name: "QvacBareKit", targets: ["QvacBareKit"]),
  ],
  dependencies: [
    // The Bare Kit that bare-stow pins, which the addons are checked against.
    .package(url: "https://github.com/holepunchto/bare-kit-swift", exact: "2.2.0"),
    .package(url: "https://github.com/holepunchto/bare-rpc-swift", .upToNextMajor(from: "3.0.0")),
    .package(url: "https://github.com/holepunchto/bare-stow-host-swift", .upToNextMinor(from: "0.2.1")),
    .package(url: "https://github.com/holepunchto/compact-encoding-swift", .upToNextMajor(from: "1.0.1")),
  ],
  targets: [
    .target(
      name: "QvacSDK",
      dependencies: [
        .product(name: "BareRPC", package: "bare-rpc-swift"),
        .product(name: "BareStowHost", package: "bare-stow-host-swift"),
        .product(name: "CompactEncoding", package: "compact-encoding-swift"),
      ],
      path: "packages/sdk-swift/Sources/QvacSDK"
    ),
    .target(
      name: "QvacBareKit",
      dependencies: [
        "QvacSDK",
        .product(name: "BareKit", package: "bare-kit-swift"),
        .product(name: "BareStowHost", package: "bare-stow-host-swift"),
      ],
      path: "packages/sdk-swift/Sources/QvacBareKit"
    ),
    .testTarget(
      name: "QvacSDKTests",
      dependencies: ["QvacSDK"],
      path: "packages/sdk-swift/Tests/QvacSDKTests"
    ),
  ]
)
