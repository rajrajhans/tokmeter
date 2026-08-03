// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TokmeterHUD",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "TokmeterHUD", targets: ["TokmeterHUD"]),
    ],
    targets: [
        .executableTarget(
            name: "TokmeterHUD",
            path: "Sources/TokmeterHUD"
        ),
    ]
)
