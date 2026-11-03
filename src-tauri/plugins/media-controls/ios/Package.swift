// swift-tools-version:5.9

import PackageDescription

let package = Package(
  name: "tauri-plugin-media-controls",
  platforms: [.iOS(.v14)],
  products: [
    .library(name: "tauri-plugin-media-controls", type: .static, targets: ["tauri-plugin-media-controls"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-media-controls",
      dependencies: [.byName(name: "Tauri")],
      path: "Sources"
    )
  ]
)
