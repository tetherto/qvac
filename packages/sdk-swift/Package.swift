// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "QvacSDK",
  platforms: [.iOS(.v15), .macOS(.v13)],
  products: [
    .library(name: "QvacSDK", targets: ["QvacSDK"]),
  ],
  dependencies: [
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
      path: "Sources/QvacSDK"
    ),
    .testTarget(
      name: "QvacSDKTests",
      dependencies: ["QvacSDK"],
      path: "Tests/QvacSDKTests"
    ),
  ]
)
