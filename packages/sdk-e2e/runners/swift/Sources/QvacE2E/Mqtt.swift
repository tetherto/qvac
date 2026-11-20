import Foundation
import Security

public struct MqttSettings: Sendable {
    public var url: String
    public var username: String?
    public var password: String?
    /// A PEM bundle to trust for wss, in place of the platform store.
    public var ca: String?
    public var rejectUnauthorized: Bool
    /// Set: MQTT 5 with a session the broker keeps this long across reconnects. Nil: MQTT 3.1.1,
    /// which the local broker speaks. As packages/test-suite/src/utils/mqtt-session.ts decides.
    public var sessionExpiryInterval: UInt32?

    public init(url: String, username: String?, password: String?, ca: String?, rejectUnauthorized: Bool, sessionExpiryInterval: UInt32?) {
        self.url = url
        self.username = username
        self.password = password
        self.ca = ca
        self.rejectUnauthorized = rejectUnauthorized
        self.sessionExpiryInterval = sessionExpiryInterval
    }
}

public struct MqttError: Error, CustomStringConvertible {
    public let description: String
    init(_ description: String) { self.description = description }
}

/// An MQTT client over a WebSocket, as much of MQTT 3.1.1 and 5 as the consumer protocol uses:
/// QoS 0 and 1, a persistent session, keepalive, reconnect, and publishes held while offline.
public final class MqttLink: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    public struct Listener: Sendable {
        public var connected: @Sendable (_ reconnect: Bool) -> Void
        public var message: @Sendable (_ topic: String, _ payload: Data) -> Void
        public var lost: @Sendable (_ reason: String) -> Void

        public init(
            connected: @escaping @Sendable (Bool) -> Void, message: @escaping @Sendable (String, Data) -> Void,
            lost: @escaping @Sendable (String) -> Void
        ) {
            self.connected = connected
            self.message = message
            self.lost = lost
        }
    }

    public typealias Done = @Sendable (Error?) -> Void

    private struct Outgoing {
        let topic: String
        let payload: Data
        let qos: UInt8
        let done: Done?
    }

    private struct Inflight {
        let id: UInt16
        let outgoing: Outgoing
    }

    private let settings: MqttSettings
    private let clientId: String
    private let version: UInt8
    private let queue = DispatchQueue(label: "qvac.e2e.mqtt")
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var listener: Listener?
    private var buffer = Data()
    private var online = false
    private var everConnected = false
    private var closed = false
    private var nextPacketId: UInt16 = 0
    /// QoS 1 publishes sent and not yet acknowledged, in the order they were sent. They outlive a
    /// dropped connection: a resumed session re-sends them with their packet ids.
    private var inflight: [Inflight] = []
    private var pendingSubscribes: [UInt16: Done] = [:]
    /// Topics subscribed so far, subscribed again when a reconnect finds no saved session, as mqtt.js does.
    private var subscriptions: [String] = []
    /// Publishes not sent yet: held while offline, or past the broker's Receive Maximum.
    private var queued: [Outgoing] = []
    private var receiveMaximum = Int(UInt16.max)
    private var keepAlive = MqttLink.keepAliveSeconds
    private var lastInbound: UInt64 = 0
    private var lastPing: UInt64 = 0
    private var ticker: DispatchSourceTimer?

    private static let keepAliveSeconds: UInt16 = 30
    /// Below the idle timeouts load balancers put on a WebSocket, so the connection is never idle.
    private static let pingSeconds: UInt64 = 20
    private static let reconnectSeconds = 3.0
    private static let connectTimeoutSeconds = 15.0
    /// Publishes held while offline, as mqtt.js does: a result sent in a blip arrives on reconnect.
    private static let offlineLimit = 10_000

    public init(settings: MqttSettings, clientId: String) {
        self.settings = settings
        self.clientId = clientId
        self.version = settings.sessionExpiryInterval == nil ? 4 : 5
        super.init()
        self.session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    }

    public func connect(_ listener: Listener) {
        queue.async {
            self.listener = listener
            self.open()
        }
    }

    public func subscribe(_ topics: [String], done: @escaping Done) {
        queue.async {
            guard self.online else {
                done(MqttError("subscribe while offline"))
                return
            }
            self.subscriptions.append(contentsOf: topics.filter { !self.subscriptions.contains($0) })
            let id = self.packetId()
            self.pendingSubscribes[id] = done
            self.send(MqttPacket.subscribe(version: self.version, packetId: id, topics: topics))
        }
    }

    public func publish(_ topic: String, _ payload: Data, qos: UInt8 = 1, done: Done? = nil) {
        queue.async {
            let outgoing = Outgoing(topic: topic, payload: payload, qos: qos, done: done)
            if self.queued.isEmpty && self.canSend(outgoing) {
                self.write(outgoing)
            } else if self.queued.count < Self.offlineLimit {
                self.queued.append(outgoing)
            } else {
                done?(MqttError("offline buffer is full"))
            }
        }
    }

    /// Ends the session: on MQTT 5 the session expiry drops to zero so the broker forgets it.
    public func close() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async {
                self.closed = true
                self.ticker?.cancel()
                guard let task = self.task, self.online else {
                    self.task?.cancel(with: .normalClosure, reason: nil)
                    continuation.resume()
                    return
                }
                task.send(.data(MqttPacket.disconnect(version: self.version))) { _ in
                    task.cancel(with: .normalClosure, reason: nil)
                    continuation.resume()
                }
            }
        }
        session.invalidateAndCancel()
    }

    // MARK: connection

    private func open() {
        if closed { return }
        guard let url = URL(string: settings.url) else {
            listener?.lost("invalid broker URL")
            return
        }
        buffer = Data()
        // Bounds the handshake only: a WebSocket task does not treat it as an idle timeout.
        var request = URLRequest(url: url, timeoutInterval: Self.connectTimeoutSeconds)
        request.setValue("mqtt", forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        receive(task)
        send(
            MqttPacket.connect(
                version: version, clientId: clientId, username: settings.username, password: settings.password,
                keepAlive: Self.keepAliveSeconds, sessionExpiry: settings.sessionExpiryInterval))
        queue.asyncAfter(deadline: .now() + Self.connectTimeoutSeconds) {
            if self.task === task && !self.online { self.drop(task, "connect timed out") }
        }
    }

    private func drop(_ task: URLSessionWebSocketTask, _ reason: String) {
        guard self.task === task else { return }
        self.task = nil
        task.cancel(with: .goingAway, reason: nil)
        ticker?.cancel()
        ticker = nil
        let wasOnline = online
        online = false
        for done in pendingSubscribes.values { done(MqttError("connection lost")) }
        pendingSubscribes.removeAll()
        if closed { return }
        listener?.lost(wasOnline ? reason : "connect failed: \(reason)")
        queue.asyncAfter(deadline: .now() + Self.reconnectSeconds) { self.open() }
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard self.task === task else { return }
                switch result {
                case .failure(let error):
                    self.drop(task, error.localizedDescription)
                case .success(let message):
                    self.lastInbound = Self.uptime()
                    switch message {
                    case .data(let data): self.buffer.append(data)
                    case .string(let text): self.buffer.append(Data(text.utf8))
                    @unknown default: break
                    }
                    do {
                        try self.drain(task)
                        self.receive(task)
                    } catch {
                        self.drop(task, "\(error)")
                    }
                }
            }
        }
    }

    private func send(_ packet: Data) {
        guard let task else { return }
        task.send(.data(packet)) { [weak self] error in
            guard let self, let error else { return }
            self.queue.async { self.drop(task, error.localizedDescription) }
        }
    }

    private static func uptime() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

    /// Pings often enough for the keepalive and the load balancer, and drops a connection the
    /// broker has gone quiet on for 1.5 times the keepalive.
    private func startTicking(_ task: URLSessionWebSocketTask) {
        ticker?.cancel()
        let now = Self.uptime()
        lastInbound = now
        lastPing = now
        let pingEvery = (keepAlive > 0 ? min(Self.pingSeconds, max(1, UInt64(keepAlive) * 3 / 4)) : Self.pingSeconds) * 1_000_000_000
        let silenceLimit = UInt64(keepAlive) * 1_500_000_000
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
        timer.setEventHandler { [weak self] in
            guard let self, self.task === task else { return }
            let now = Self.uptime()
            if silenceLimit > 0 && now - self.lastInbound > silenceLimit {
                self.drop(task, "keepalive timed out")
                return
            }
            if now - self.lastPing >= pingEvery {
                self.lastPing = now
                self.send(MqttPacket.pingreq)
            }
        }
        timer.resume()
        ticker = timer
    }

    private func packetId() -> UInt16 {
        repeat {
            nextPacketId = nextPacketId == UInt16.max ? 1 : nextPacketId + 1
        } while pendingSubscribes[nextPacketId] != nil || inflight.contains { $0.id == nextPacketId }
        return nextPacketId
    }

    private func canSend(_ outgoing: Outgoing) -> Bool {
        online && (outgoing.qos == 0 || inflight.count < receiveMaximum)
    }

    private func write(_ outgoing: Outgoing) {
        var id: UInt16?
        if outgoing.qos > 0 {
            let assigned = packetId()
            inflight.append(Inflight(id: assigned, outgoing: outgoing))
            id = assigned
        }
        send(
            MqttPacket.publish(
                version: version,
                MqttPacket.Publish(topic: outgoing.topic, qos: outgoing.qos, packetId: id, dup: false, payload: outgoing.payload)))
        if outgoing.qos == 0 { outgoing.done?(nil) }
    }

    /// Sends what is queued, in order, while the broker's Receive Maximum allows.
    private func flush() {
        while let next = queued.first, canSend(next) {
            queued.removeFirst()
            write(next)
        }
    }

    // MARK: incoming packets

    private func drain(_ task: URLSessionWebSocketTask) throws {
        while let frame = try MqttPacket.next(buffer) {
            buffer.removeFirst(frame.length)
            try handle(frame, task)
        }
    }

    private func handle(_ frame: MqttPacket.Frame, _ task: URLSessionWebSocketTask) throws {
        switch frame.type {
        case MqttPacket.connAckType:
            let ack = try MqttPacket.connAck(frame.body, version: version)
            guard ack.code == 0 else { throw MqttError("broker refused the connection (code \(ack.code))") }
            online = true
            receiveMaximum = Int(max(1, ack.receiveMaximum ?? UInt16.max))
            keepAlive = ack.serverKeepAlive ?? Self.keepAliveSeconds
            let reconnect = everConnected
            everConnected = true
            startTicking(task)
            if ack.sessionPresent {
                for entry in inflight {
                    let outgoing = entry.outgoing
                    send(
                        MqttPacket.publish(
                            version: version,
                            MqttPacket.Publish(topic: outgoing.topic, qos: outgoing.qos, packetId: entry.id, dup: true, payload: outgoing.payload)))
                }
            } else {
                queued.insert(contentsOf: inflight.map(\.outgoing), at: 0)
                inflight.removeAll()
                if !subscriptions.isEmpty {
                    let id = packetId()
                    pendingSubscribes[id] = { _ in }
                    send(MqttPacket.subscribe(version: version, packetId: id, topics: subscriptions))
                }
            }
            listener?.connected(reconnect)
            flush()
        case MqttPacket.publishType:
            let publish = try MqttPacket.publish(frame.body, flags: frame.flags, version: version)
            if let id = publish.packetId { send(MqttPacket.pubAck(id)) }
            listener?.message(publish.topic, publish.payload)
        case MqttPacket.pubAckType:
            let ack = try MqttPacket.pubAck(frame.body)
            if let index = inflight.firstIndex(where: { $0.id == ack.packetId }) {
                let entry = inflight.remove(at: index)
                entry.outgoing.done?(ack.code < 0x80 ? nil : MqttError("publish refused (reason \(ack.code))"))
            }
            flush()
        case MqttPacket.subAckType:
            let ack = try MqttPacket.subAck(frame.body, version: version)
            if let done = pendingSubscribes.removeValue(forKey: ack.packetId) {
                done(ack.codes.contains { $0 >= 0x80 } ? MqttError("subscribe refused") : nil)
            }
        case MqttPacket.disconnectType:
            let reason = try MqttPacket.disconnectReason(frame.body, version: version)
            throw MqttError(reason.map { "broker disconnected (\($0))" } ?? "broker disconnected")
        default: break
        }
    }

    // MARK: trust

    public func urlSession(
        _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
            let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        if !settings.rejectUnauthorized {
            completionHandler(.useCredential, URLCredential(trust: trust))
            return
        }
        guard let ca = settings.ca else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        SecTrustSetAnchorCertificates(trust, Self.certificates(ca) as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        if SecTrustEvaluateWithError(trust, nil) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    private static func certificates(_ pem: String) -> [SecCertificate] {
        pem.components(separatedBy: "-----BEGIN CERTIFICATE-----").dropFirst().compactMap { block in
            guard let body = block.components(separatedBy: "-----END CERTIFICATE-----").first,
                let der = Data(base64Encoded: body.filter { !$0.isWhitespace })
            else { return nil }
            return SecCertificateCreateWithData(nil, der as CFData)
        }
    }
}

/// The packets MqttLink sends and reads. `version` is the protocol level: 4 for 3.1.1, 5 for 5.
enum MqttPacket {
    static let connAckType: UInt8 = 2
    static let publishType: UInt8 = 3
    static let pubAckType: UInt8 = 4
    static let subAckType: UInt8 = 9
    static let disconnectType: UInt8 = 14

    struct Frame: Equatable {
        let type: UInt8
        let flags: UInt8
        let body: Data
        /// The whole packet's size in the buffer.
        let length: Int
    }

    struct ConnAck: Equatable {
        var sessionPresent: Bool
        var code: UInt8
        var receiveMaximum: UInt16?
        var serverKeepAlive: UInt16?
    }

    struct Publish: Equatable {
        var topic: String
        var qos: UInt8
        var packetId: UInt16?
        var dup: Bool
        var payload: Data
    }

    struct Ack: Equatable {
        var packetId: UInt16
        var code: UInt8
    }

    struct SubAck: Equatable {
        var packetId: UInt16
        var codes: [UInt8]
    }

    // MARK: encoding

    static let pingreq = Data([0xC0, 0x00])

    static func connect(
        version: UInt8, clientId: String, username: String?, password: String?, keepAlive: UInt16, sessionExpiry: UInt32?
    ) -> Data {
        // 3.1.1 forbids a password without a username; 5 allows it.
        let password = version == 5 || username != nil ? password : nil
        var body = string("MQTT")
        body.append(version)
        var flags: UInt8 = 0
        if username != nil { flags |= 0x80 }
        if password != nil { flags |= 0x40 }
        body.append(flags)
        body.append(uint16(keepAlive))
        if version == 5 {
            var properties = Data()
            if let sessionExpiry {
                properties.append(0x11)
                properties.append(uint32(sessionExpiry))
            }
            body.append(remainingLength(properties.count))
            body.append(properties)
        }
        body.append(string(clientId))
        if let username { body.append(string(username)) }
        if let password { body.append(string(password)) }
        return packet(0x10, body)
    }

    static func publish(version: UInt8, _ publish: Publish) -> Data {
        var body = string(publish.topic)
        if publish.qos > 0, let id = publish.packetId { body.append(uint16(id)) }
        if version == 5 { body.append(0) }
        body.append(publish.payload)
        return packet(0x30 | (publish.dup ? 0x08 : 0) | (publish.qos << 1), body)
    }

    static func pubAck(_ packetId: UInt16) -> Data { packet(0x40, uint16(packetId)) }

    static func subscribe(version: UInt8, packetId: UInt16, topics: [String]) -> Data {
        var body = uint16(packetId)
        if version == 5 { body.append(0) }
        for topic in topics {
            body.append(string(topic))
            body.append(1)
        }
        return packet(0x82, body)
    }

    /// On 5 it also sets the session expiry to zero, so the broker forgets the session.
    static func disconnect(version: UInt8) -> Data {
        version == 5 ? packet(0xE0, Data([0x00, 0x05, 0x11, 0, 0, 0, 0])) : packet(0xE0, Data())
    }

    static func packet(_ header: UInt8, _ body: Data) -> Data { Data([header]) + remainingLength(body.count) + body }

    static func remainingLength(_ value: Int) -> Data {
        var value = value
        var out = Data()
        repeat {
            var byte = UInt8(value % 128)
            value /= 128
            if value > 0 { byte |= 0x80 }
            out.append(byte)
        } while value > 0
        return out
    }

    private static func uint16(_ value: UInt16) -> Data { Data([UInt8(value >> 8), UInt8(value & 0xFF)]) }

    private static func uint32(_ value: UInt32) -> Data {
        Data([UInt8(value >> 24), UInt8((value >> 16) & 0xFF), UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF)])
    }

    private static func string(_ value: String) -> Data {
        let utf8 = Data(value.utf8)
        return uint16(UInt16(utf8.count)) + utf8
    }

    // MARK: decoding

    /// The first whole packet in `data`, or nil while it is still arriving.
    static func next(_ data: Data) throws -> Frame? {
        guard data.count >= 2 else { return nil }
        let bytes = [UInt8](data.prefix(5))
        var length = 0
        var multiplier = 1
        var index = 1
        while true {
            guard index < bytes.count else {
                if index >= 5 { throw MqttError("malformed remaining length") }
                return nil
            }
            let byte = bytes[index]
            length += Int(byte & 0x7F) * multiplier
            multiplier *= 128
            index += 1
            if byte & 0x80 == 0 { break }
        }
        guard data.count >= index + length else { return nil }
        let start = data.startIndex
        return Frame(
            type: bytes[0] >> 4, flags: bytes[0] & 0x0F, body: Data(data[start + index..<start + index + length]), length: index + length)
    }

    static func connAck(_ body: Data, version: UInt8) throws -> ConnAck {
        var reader = Reader(body)
        var ack = ConnAck(sessionPresent: try reader.byte() & 0x01 == 1, code: try reader.byte())
        if version == 5 && reader.remaining > 0 {
            let properties = try reader.properties()
            ack.receiveMaximum = properties.receiveMaximum
            ack.serverKeepAlive = properties.serverKeepAlive
        }
        return ack
    }

    static func publish(_ body: Data, flags: UInt8, version: UInt8) throws -> Publish {
        var reader = Reader(body)
        let qos = (flags >> 1) & 0x03
        let topic = try reader.string()
        let id: UInt16? = try qos > 0 ? reader.uint16() : nil
        if version == 5 { try reader.skip(try reader.varint()) }
        return Publish(topic: topic, qos: qos, packetId: id, dup: flags & 0x08 != 0, payload: reader.rest())
    }

    static func pubAck(_ body: Data) throws -> Ack {
        var reader = Reader(body)
        let id = try reader.uint16()
        return Ack(packetId: id, code: try reader.remaining > 0 ? reader.byte() : 0)
    }

    static func subAck(_ body: Data, version: UInt8) throws -> SubAck {
        var reader = Reader(body)
        let id = try reader.uint16()
        if version == 5 { try reader.skip(try reader.varint()) }
        return SubAck(packetId: id, codes: [UInt8](reader.rest()))
    }

    /// What a broker's DISCONNECT says, on 5: its reason code and any reason string.
    static func disconnectReason(_ body: Data, version: UInt8) throws -> String? {
        guard version == 5, !body.isEmpty else { return nil }
        var reader = Reader(body)
        let code = try reader.byte()
        let reasonString = try reader.remaining > 0 ? reader.properties().reasonString : nil
        let hex = String(format: "reason 0x%02X", code)
        return reasonString.map { "\(hex): \($0)" } ?? hex
    }

    struct Properties {
        var receiveMaximum: UInt16?
        var serverKeepAlive: UInt16?
        var reasonString: String?
    }

    private struct Reader {
        private let bytes: [UInt8]
        private var offset = 0

        init(_ data: Data) { bytes = [UInt8](data) }

        var remaining: Int { bytes.count - offset }

        mutating func byte() throws -> UInt8 {
            guard offset < bytes.count else { throw MqttError("truncated packet") }
            defer { offset += 1 }
            return bytes[offset]
        }

        mutating func uint16() throws -> UInt16 { UInt16(try byte()) << 8 | UInt16(try byte()) }

        mutating func varint() throws -> Int {
            var value = 0
            var multiplier = 1
            for _ in 0..<4 {
                let byte = try self.byte()
                value += Int(byte & 0x7F) * multiplier
                if byte & 0x80 == 0 { return value }
                multiplier *= 128
            }
            throw MqttError("malformed variable integer")
        }

        mutating func skip(_ count: Int) throws {
            guard offset + count <= bytes.count else { throw MqttError("truncated packet") }
            offset += count
        }

        mutating func string() throws -> String {
            let length = Int(try uint16())
            guard offset + length <= bytes.count else { throw MqttError("truncated packet") }
            defer { offset += length }
            return String(decoding: bytes[offset..<offset + length], as: UTF8.self)
        }

        mutating func rest() -> Data {
            defer { offset = bytes.count }
            return Data(bytes[offset...])
        }

        /// An MQTT 5 property list, keeping the properties the link uses and skipping the rest.
        mutating func properties() throws -> Properties {
            let length = try varint()
            let end = offset + length
            guard end <= bytes.count else { throw MqttError("truncated packet") }
            var properties = Properties()
            while offset < end {
                let id = try varint()
                switch id {
                case 0x21: properties.receiveMaximum = try uint16()
                case 0x13: properties.serverKeepAlive = try uint16()
                case 0x1F: properties.reasonString = try string()
                case 0x01, 0x17, 0x19, 0x24, 0x25, 0x28, 0x29, 0x2A: try skip(1)
                case 0x22, 0x23: try skip(2)
                case 0x02, 0x11, 0x18, 0x27: try skip(4)
                case 0x0B: _ = try varint()
                case 0x03, 0x08, 0x09, 0x12, 0x15, 0x16, 0x1A, 0x1C: try skip(Int(try uint16()))
                case 0x26:
                    try skip(Int(try uint16()))
                    try skip(Int(try uint16()))
                default: throw MqttError("unknown MQTT property 0x\(String(id, radix: 16))")
                }
            }
            guard offset == end else { throw MqttError("malformed properties") }
            return properties
        }
    }
}
