// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "QvacE2E",
  platforms: [.iOS(.v15), .macOS(.v13)],
  products: [
    .library(name: "QvacE2E", targets: ["QvacE2E"])
  ],
  dependencies: [
    .package(path: "../../../sdk-swift")
  ],
  targets: [
    .target(
      name: "QvacE2E",
      dependencies: [.product(name: "QvacSDK", package: "sdk-swift")]
    )
  ]
)
