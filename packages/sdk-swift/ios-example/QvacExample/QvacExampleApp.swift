import QvacSDK
import QvacWorker
import SwiftUI

@main
struct QvacExampleApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var status = "Starting the worker"
    @State private var answer = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Status") { Text(status) }
                Section("Answer") { Text(answer) }
            }
            .navigationTitle("QVAC")
        }
        .task { await run() }
    }

    private func run() async {
        do {
            let worker = try await QvacWorker.start()
            let client = try await QvacClient.connect(ipc: worker.ipc, worklet: worker.worklet)

            var modelId: String?
            for try await event in client.models.loadWithProgress(Models.QWEN3_600M_INST_Q4) {
                switch event {
                case .progress(let progress): status = "Downloading the model: \(Int(progress.percentage))%"
                case .result(let loaded): modelId = loaded.modelId
                }
            }
            guard let modelId else {
                status = "The model did not load"
                return
            }

            status = "Generating"
            let run = try client.completion.run(
                modelId: modelId,
                history: [.user("Name three colors of the rainbow in one sentence.")]
            )
            for try await token in run.tokens { answer += token }
            let stats = try await run.stats()
            status = "Done at \(Int(stats?.tokensPerSecond ?? 0)) tokens per second"

            _ = try await client.models.unload(modelId)
            await client.close()
        } catch {
            status = "Failed: \(error)"
        }
    }
}
