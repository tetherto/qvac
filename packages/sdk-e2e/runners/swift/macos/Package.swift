// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "QvacE2EBridge",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "qvac-e2e-bridge", targets: ["QvacE2EBridge"])
  ],
  dependencies: [
    .package(path: ".."),
    .package(path: "../../../../sdk-swift"),
    .package(path: "QvacWorker"),
  ],
  targets: [
    .executableTarget(
      name: "QvacE2EBridge",
      dependencies: [
        .product(name: "QvacE2E", package: "swift"),
        .product(name: "QvacSDK", package: "sdk-swift"),
        .product(name: "QvacWorker", package: "QvacWorker"),
      ]
    )
  ]
)
