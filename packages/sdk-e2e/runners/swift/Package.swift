// swift-tools-version: 5.10
import Foundation
import PackageDescription

// The checkout's directory name, which CI does not keep as "qvac".
let rootIdentity = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .appendingPathComponent("../../../..").standardizedFileURL.lastPathComponent

let package = Package(
  name: "QvacE2E",
  platforms: [.iOS(.v15), .macOS(.v13)],
  products: [
    .library(name: "QvacE2E", targets: ["QvacE2E"])
  ],
  dependencies: [
    .package(path: "../../../..")
  ],
  targets: [
    .target(
      name: "QvacE2E",
      dependencies: [.product(name: "QvacSDK", package: rootIdentity)]
    ),
    .testTarget(
      name: "QvacE2ETests",
      dependencies: ["QvacE2E"]
    ),
  ]
)
