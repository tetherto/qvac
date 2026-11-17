// swift-tools-version: 5.10
import Foundation
import PackageDescription

// The checkout's directory name, which CI does not keep as "qvac".
let rootIdentity = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .appendingPathComponent("../../../../..").standardizedFileURL.lastPathComponent

let package = Package(
  name: "QvacE2EBridge",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "qvac-e2e-bridge", targets: ["QvacE2EBridge"])
  ],
  dependencies: [
    .package(path: ".."),
    .package(path: "../../../../.."),
    .package(path: "QvacWorker"),
  ],
  targets: [
    .executableTarget(
      name: "QvacE2EBridge",
      dependencies: [
        .product(name: "QvacE2E", package: "swift"),
        .product(name: "QvacSDK", package: rootIdentity),
        .product(name: "QvacWorker", package: "QvacWorker"),
      ]
    )
  ]
)
