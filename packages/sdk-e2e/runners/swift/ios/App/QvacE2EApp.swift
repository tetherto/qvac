import SwiftUI

@main
struct QvacE2EApp: App {
    @StateObject private var session = Session()

    var body: some Scene {
        WindowGroup {
            ScrollViewReader { scroll in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        // Ids are positions in the whole log, so they stay stable after the display cap drops old lines.
                        ForEach(Array(session.lines.enumerated()), id: \.offset) { index, line in
                            Text(line).font(.system(.caption, design: .monospaced))
                                .id(session.shown - session.lines.count + index)
                        }
                    }
                    .padding()
                }
                .onChange(of: session.shown) { shown in
                    scroll.scrollTo(shown - 1, anchor: .bottom)
                }
            }
            .task { await session.run() }
        }
    }
}
