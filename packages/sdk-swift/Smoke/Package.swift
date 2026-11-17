// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "Smoke",
  platforms: [.macOS(.v13)],
  dependencies: [
    .package(path: ".."),
    .package(path: "QvacWorker"),
  ],
  targets: [
    .executableTarget(
      name: "Smoke",
      dependencies: [
        .product(name: "QvacSDK", package: "sdk-swift"),
        .product(name: "QvacWorker", package: "QvacWorker"),
      ]
    )
  ]
)
