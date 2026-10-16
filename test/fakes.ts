/**
 * Test doubles for discord.js and the MCP SDK, so server.ts can be imported
 * and driven without a network, a bot token or a Claude Code process.
 *
 * Call installFakes() before `await import('../server.ts')`.
 */
import { mock } from 'bun:test'

type Handler = (...args: any[]) => any

export const ChannelType = { GuildText: 0, DM: 1, PublicThread: 11 } as const

export class FakeUser {
  sent: any[] = []
  constructor(public id: string) {}
  async send(payload: any) {
    this.sent.push(payload)
    return { id: `sent-${this.sent.length}` }
  }
}

export class FakeChannel {
  sent: any[] = []
  messages = { fetch: async (id: any) => this.byId.get(id) }
  byId = new Map<string, any>()
  constructor(
    public id: string,
    public type: number = ChannelType.GuildText,
    public guildId: string | null = null,
    public parentId: string | null = null,
    public recipientId: string | null = null,
  ) {}
  isTextBased() { return true }
  isThread() { return this.type === ChannelType.PublicThread }
  async sendTyping() {}
  async send(payload: any) {
    this.sent.push(payload)
    return { id: `out-${this.id}-${this.sent.length}` }
  }
}

export class FakeClient {
  handlers = new Map<string, Handler[]>()
  user = { id: 'bot-id', tag: 'bot#0001' }
  usersById = new Map<string, FakeUser>()
  channelsById = new Map<string, FakeChannel>()
  users = { fetch: async (id: string) => this.userFor(id) }
  channels = { fetch: async (id: string) => this.channelsById.get(id) ?? null }
  constructor(_opts: unknown) { fakes.client = this }
  userFor(id: string) {
    let u = this.usersById.get(id)
    if (!u) { u = new FakeUser(id); this.usersById.set(id, u) }
    return u
  }
  on(ev: string, fn: Handler) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]); return this }
  once(ev: string, fn: Handler) { return this.on(ev, fn) }
  async emit(ev: string, ...args: any[]) {
    for (const fn of this.handlers.get(ev) ?? []) await fn(...args)
    // Handlers fire async work without awaiting it (like the real server).
    await new Promise(r => setTimeout(r, 5))
  }
  async login() { return 'ok' }
  async destroy() {}
}

class Builder {
  data: Record<string, unknown> = {}
  components: any[] = []
  setCustomId(v: string) { this.data.custom_id = v; return this }
  setLabel(v: string) { this.data.label = v; return this }
  setEmoji(v: string) { this.data.emoji = v; return this }
  setStyle(v: number) { this.data.style = v; return this }
  addComponents(...c: any[]) { this.components.push(...c); return this }
}

export class FakeMcpServer {
  notifications: any[] = []
  notificationHandlers: { schema: any; fn: Handler }[] = []
  requestHandlers = new Map<any, Handler>()
  constructor(public info: unknown, public options: any) { fakes.mcp = this }
  setNotificationHandler(schema: any, fn: Handler) { this.notificationHandlers.push({ schema, fn }) }
  setRequestHandler(schema: any, fn: Handler) { this.requestHandlers.set(schema, fn) }
  async notification(n: any) { this.notifications.push(n) }
  async connect() {}
  /** Deliver a notification from "Claude Code" to the server. */
  async receive(method: string, params: any) {
    for (const h of this.notificationHandlers) {
      const parsed = h.schema.safeParse({ method, params })
      if (parsed.success) await h.fn(parsed.data)
    }
  }
  async callTool(name: string, args: Record<string, unknown>) {
    return this.requestHandlers.get(CallToolRequestSchema)!({ params: { name, arguments: args } })
  }
  async listTools() {
    return this.requestHandlers.get(ListToolsRequestSchema)!({ params: {} })
  }
}

export const ListToolsRequestSchema = { kind: 'list-tools' }
export const CallToolRequestSchema = { kind: 'call-tool' }

export const fakes: { client?: FakeClient; mcp?: FakeMcpServer } = {}

export function installFakes() {
  const anyEnum = new Proxy({}, { get: (_t, k) => String(k) })
  mock.module('discord.js', () => ({
    Client: FakeClient,
    GatewayIntentBits: anyEnum,
    Partials: anyEnum,
    ChannelType,
    ButtonBuilder: Builder,
    ActionRowBuilder: Builder,
    ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 },
  }))
  mock.module('@modelcontextprotocol/sdk/server/index.js', () => ({ Server: FakeMcpServer }))
  mock.module('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }))
  mock.module('@modelcontextprotocol/sdk/types.js', () => ({ ListToolsRequestSchema, CallToolRequestSchema }))
}

let seq = 0
export type MsgOpts = {
  author: string
  content?: string
  channel: FakeChannel
  mentioned?: boolean
}

export function fakeMessage(o: MsgOpts) {
  const id = `m${++seq}`
  const msg: any = {
    id,
    author: { id: o.author, username: `user-${o.author}`, bot: false },
    channel: o.channel,
    channelId: o.channel.id,
    guildId: o.channel.guildId,
    content: o.content ?? 'hello',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    attachments: new Map(),
    mentions: { has: () => !!o.mentioned },
    reference: null,
    replies: [] as any[],
    reactions: [] as any[],
    async reply(p: any) { msg.replies.push(p); return { id: `r-${id}` } },
    async react(e: any) { msg.reactions.push(e) },
    async edit(t: string) { return { id } },
  }
  o.channel.byId.set(id, msg)
  return msg
}

export function fakeButton(customId: string, userId: string, content = 'msg') {
  const i: any = {
    customId,
    user: { id: userId },
    message: { content },
    replies: [] as any[],
    updates: [] as any[],
    isButton: () => true,
    async reply(p: any) { i.replies.push(p) },
    async update(p: any) { i.updates.push(p) },
  }
  return i
}
