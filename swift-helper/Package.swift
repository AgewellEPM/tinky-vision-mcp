// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "TinkyOS",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "tinky-os", targets: ["TinkyOS"]),
        .executable(name: "tinky-os-scoped-ax", targets: ["TinkyScopedAX"]),
    ],
    targets: [
        .target(name: "ScopedAX", path: "Sources/ScopedAX"),
        .executableTarget(name: "TinkyOS", dependencies: ["ScopedAX"], path: "Sources/TinkyOS"),
        .executableTarget(name: "TinkyScopedAX", dependencies: ["ScopedAX"], path: "Sources/TinkyScopedAX"),
        .testTarget(name: "ScopedAXTests", dependencies: ["ScopedAX"], path: "Tests/ScopedAXTests"),
    ]
)
