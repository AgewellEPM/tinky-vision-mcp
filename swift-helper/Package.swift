// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TinkyOS",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "tinky-os", targets: ["TinkyOS"]),
    ],
    targets: [
        .executableTarget(name: "TinkyOS", path: "Sources/TinkyOS"),
    ]
)
