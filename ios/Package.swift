// swift-tools-version: 6.0

// The iOS app, as far as SwiftPM is concerned: one library and one binary
// dependency, which is CPython itself.
//
// A library rather than an executable, which reads oddly for something with a
// `@main` in it: xtool builds the app's code as a library and links the iOS
// app around it, so a package that exposes an executable is one it says it
// cannot find an app in. Exactly one library product, and `xtool.yml` names it.
//
// `Python.xcframework` is not checked in - it is a 37 MB download that
// `build-ipa` fetches into this folder, the way `build-apk` lets Gradle fetch
// CPython for the other phone. xtool copies any framework it finds behind a
// binary target into the bundle's `Frameworks/` and signs it there, which is
// exactly where iOS insists a dynamic library live.
//
// The Swift here is the part with no desktop counterpart, and it is meant to
// stay small: a window, a player, and the few lines that start the
// interpreter. The CLI, the backend and the page are staged into `app/` by
// `build-ipa` and are the same files the desktop runs.

import PackageDescription

let package = Package(
    name: "Simplmusik",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "Simplmusik",
            targets: ["Simplmusik"]
        ),
    ],
    targets: [
        .target(
            name: "Simplmusik",
            dependencies: ["Python"]
        ),
        .binaryTarget(name: "Python", path: "Python.xcframework"),
    ]
)
