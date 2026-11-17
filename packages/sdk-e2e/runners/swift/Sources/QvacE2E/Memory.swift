import Darwin

/// The process's memory as the JS mobile consumer samples it: the footprint iOS counts against an
/// app's limit, the resident size, and the number of mapped regions.
struct MemorySample {
    let footprintKb: Double
    let residentKb: Double
    let regions: Double

    static func now() -> MemorySample? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let status = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard status == KERN_SUCCESS else { return nil }
        return MemorySample(
            footprintKb: Double(info.phys_footprint) / 1024, residentKb: Double(info.resident_size) / 1024,
            regions: Double(info.region_count))
    }

    /// The `qvac/app-memory` records, by the metric names the JS iOS consumer uses.
    var records: [(metric: String, value: Double, unit: String)] {
        [
            ("task_vm_info.physFootprint", footprintKb, "kb"),
            ("task_vm_info.resident_size", residentKb, "kb"),
            ("task_vm_info.region_count", regions, "count"),
        ]
    }
}
