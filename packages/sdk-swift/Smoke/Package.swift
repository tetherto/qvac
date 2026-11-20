// swift-tools-version: 5.10
import Foundation
import PackageDescription

// The checkout's directory name, which CI does not keep as "qvac".
let rootIdentity = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .appendingPathComponent("../../..").standardizedFileURL.lastPathComponent

let package = Package(
  name: "Smoke",
  platforms: [.macOS(.v13)],
  dependencies: [
    .package(path: "../../.."),
    .package(path: "QvacWorker"),
  ],
  targets: [
    .executableTarget(
      name: "Smoke",
      dependencies: [
        .product(name: "QvacSDK", package: rootIdentity),
        .product(name: "QvacWorker", package: "QvacWorker"),
      ]
    )
  ]
)
