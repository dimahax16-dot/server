/**
 * Multiloader Community Server
 * Standalone Node.js server — deploy to Railway, Render, or Fly.io
 * All users connect to this shared instance so posts/messages are global
 */
const { createServer } = require('http')
const { WebSocketServer, WebSocket } = require('ws')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 47822
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json')

// ── Owner IDs ─────────────────────────────────────────────────────────────────
const OWNER_USER_IDS = new Set(['1246855922555420734'])

// ── Persistence ───────────────────────────────────────────────────────────────
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8')
    const d = JSON.parse(raw)
    if (!d.posts)         d.posts = []
    if (!d.files)         d.files = []
    if (!d.users)         d.users = []
    if (!d.messages)      d.messages = []
    if (!d.bans)          d.bans = []
    if (!d.verifiedUsers) d.verifiedUsers = []
    return d
  } catch {
    return { posts: [], files: [], users: [], messages: [], bans: [], verifiedUsers: [] }
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

// ── WebSocket clients ─────────────────────────────────────────────────────────
const clients = new Set()

function broadcast(event, payload) {
  const msg = JSON.stringify({ event, payload })
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
}

function json(res, status, body) {
  setCors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => resolve(body))
  })
}

function upsertUser(data, id, username, avatarUrl, role) {
  let u = data.users.find(u => u.id === id)
  if (!u) {
    u = { id, username, avatarUrl, role, followers: [], following: [], blockedBy: [] }
    data.users.push(u)
  } else {
    u.username = username
    u.avatarUrl = avatarUrl
    u.role = role
  }
  return u
}

// ── Router ────────────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const method = req.method ?? 'GET'

  if (method === 'OPTIONS') { setCors(res); res.writeHead(204); res.end(); return }

  const data = loadData()

  // ── Health check ──────────────────────────────────────────────────────────
  if (method === 'GET' && url.pathname === '/') {
    return json(res, 200, { ok: true, service: 'multiloader-community', users: data.users.length, posts: data.posts.length })
  }

  // ── Posts ─────────────────────────────────────────────────────────────────

  if (method === 'GET' && url.pathname === '/posts') {
    const game = url.searchParams.get('game')
    const posts = game && game !== 'All'
      ? data.posts.filter(p => p.game === game || p.game === 'All Games')
      : data.posts
    return json(res, 200, posts.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return b.createdAt - a.createdAt
    }))
  }

  if (method === 'POST' && url.pathname === '/posts') {
    const body = JSON.parse(await readBody(req))
    const post = {
      id: `post_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      authorId:     body.authorId ?? '',
      authorName:   body.authorName ?? 'Unknown',
      authorAvatar: body.authorAvatar ?? '',
      authorRole:   body.authorRole ?? 'User',
      game:         body.game ?? 'All Games',
      title:        body.title ?? '',
      body:         body.body ?? '',
      tags:         body.tags ?? [],
      likes:        [],
      createdAt:    Date.now(),
      pinned:       false,
      attachedFile: body.attachedFile ?? null,
      attachedNote: body.attachedNote ?? null,
      appIconUrl:   body.appIconUrl ?? '',
    }
    data.posts.unshift(post)
    saveData(data)
    broadcast('post:new', post)
    return json(res, 201, post)
  }

  // DELETE /posts/:id
  const postMatch = url.pathname.match(/^\/posts\/([^/]+)$/)
  if (method === 'DELETE' && postMatch) {
    const postId = postMatch[1]
    const body = JSON.parse(await readBody(req))
    const requesterId = body.requesterId ?? ''
    const post = data.posts.find(p => p.id === postId)
    if (!post) return json(res, 404, { error: 'Not found' })
    if (!OWNER_USER_IDS.has(requesterId) && post.authorId !== requesterId)
      return json(res, 403, { error: 'Forbidden' })
    data.posts = data.posts.filter(p => p.id !== postId)
    saveData(data)
    broadcast('post:deleted', { postId })
    return json(res, 200, { ok: true })
  }

  // POST /posts/:id/pin
  const pinMatch = url.pathname.match(/^\/posts\/([^/]+)\/pin$/)
  if (method === 'POST' && pinMatch) {
    const postId = pinMatch[1]
    const body = JSON.parse(await readBody(req))
    if (!OWNER_USER_IDS.has(body.requesterId ?? '')) return json(res, 403, { error: 'Forbidden' })
    const post = data.posts.find(p => p.id === postId)
    if (!post) return json(res, 404, { error: 'Not found' })
    post.pinned = !post.pinned
    saveData(data)
    broadcast('post:pin', { postId, pinned: post.pinned })
    return json(res, 200, { pinned: post.pinned })
  }

  // POST /posts/:id/like
  const likeMatch = url.pathname.match(/^\/posts\/([^/]+)\/like$/)
  if (method === 'POST' && likeMatch) {
    const postId = likeMatch[1]
    const body = JSON.parse(await readBody(req))
    const userId = body.userId
    const post = data.posts.find(p => p.id === postId)
    if (!post) return json(res, 404, { error: 'Not found' })
    const idx = post.likes.indexOf(userId)
    if (idx === -1) post.likes.push(userId)
    else post.likes.splice(idx, 1)
    saveData(data)
    broadcast('post:like', { postId, likes: post.likes })
    return json(res, 200, { likes: post.likes })
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  if (method === 'GET' && url.pathname === '/users') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const users = q
      ? data.users.filter(u => u.username.toLowerCase().includes(q))
      : data.users
    return json(res, 200, users.map(u => ({
      id: u.id, username: u.username, avatarUrl: u.avatarUrl, role: u.role,
      followers: u.followers.length, following: u.following.length,
      bannedUntil: u.bannedUntil, banReason: u.banReason,
    })))
  }

  if (method === 'POST' && url.pathname === '/users/register') {
    const body = JSON.parse(await readBody(req))
    const role = OWNER_USER_IDS.has(body.id) ? 'Owner' : (body.role ?? 'User')
    const u = upsertUser(data, body.id, body.username, body.avatarUrl ?? '', role)
    saveData(data)
    return json(res, 200, u)
  }

  if (method === 'GET' && url.pathname === '/users/verified') {
    return json(res, 200, { verifiedUsers: data.verifiedUsers })
  }

  const followMatch = url.pathname.match(/^\/users\/([^/]+)\/follow$/)
  if (method === 'POST' && followMatch) {
    const targetId = followMatch[1]
    const body = JSON.parse(await readBody(req))
    const fromId = body.fromId
    const target = data.users.find(u => u.id === targetId)
    const from   = data.users.find(u => u.id === fromId)
    if (!target || !from) return json(res, 404, { error: 'User not found' })
    if (!target.followers.includes(fromId)) target.followers.push(fromId)
    if (!from.following.includes(targetId)) from.following.push(targetId)
    saveData(data)
    broadcast('user:follow', { targetId, fromId })
    return json(res, 200, { ok: true })
  }

  const unfollowMatch = url.pathname.match(/^\/users\/([^/]+)\/unfollow$/)
  if (method === 'POST' && unfollowMatch) {
    const targetId = unfollowMatch[1]
    const body = JSON.parse(await readBody(req))
    const fromId = body.fromId
    const target = data.users.find(u => u.id === targetId)
    const from   = data.users.find(u => u.id === fromId)
    if (target) target.followers = target.followers.filter(id => id !== fromId)
    if (from)   from.following   = from.following.filter(id => id !== targetId)
    saveData(data)
    return json(res, 200, { ok: true })
  }

  const blockMatch = url.pathname.match(/^\/users\/([^/]+)\/block$/)
  if (method === 'POST' && blockMatch) {
    const targetId = blockMatch[1]
    const body = JSON.parse(await readBody(req))
    const target = data.users.find(u => u.id === targetId)
    if (target && !target.blockedBy.includes(body.fromId)) target.blockedBy.push(body.fromId)
    saveData(data)
    return json(res, 200, { ok: true })
  }

  const banMatch = url.pathname.match(/^\/users\/([^/]+)\/ban$/)
  if (method === 'POST' && banMatch) {
    const targetId = banMatch[1]
    const body = JSON.parse(await readBody(req))
    const target = data.users.find(u => u.id === targetId)
    if (!target) return json(res, 404, { error: 'User not found' })
    target.bannedUntil = body.permanent ? 0 : (Date.now() + (body.durationHours ?? 24) * 3600000)
    target.banReason   = body.reason ?? 'Banned by admin'
    data.bans.push({ userId: targetId, reason: target.banReason, bannedAt: Date.now(), bannedUntil: target.bannedUntil })
    saveData(data)
    broadcast('user:banned', { userId: targetId, reason: target.banReason })
    return json(res, 200, { ok: true })
  }

  const unbanMatch = url.pathname.match(/^\/users\/([^/]+)\/unban$/)
  if (method === 'POST' && unbanMatch) {
    const targetId = unbanMatch[1]
    const target = data.users.find(u => u.id === targetId)
    if (target) { delete target.bannedUntil; delete target.banReason }
    saveData(data)
    return json(res, 200, { ok: true })
  }

  const verifyMatch = url.pathname.match(/^\/users\/([^/]+)\/verify$/)
  if (method === 'POST' && verifyMatch) {
    const targetId = verifyMatch[1]
    const body = JSON.parse(await readBody(req))
    if (!OWNER_USER_IDS.has(body.requesterId ?? '')) return json(res, 403, { error: 'Forbidden' })
    if (!data.verifiedUsers.includes(targetId)) data.verifiedUsers.push(targetId)
    const target = data.users.find(u => u.id === targetId)
    if (target && target.role === 'User') target.role = 'Verified'
    saveData(data)
    broadcast('user:verified', { userId: targetId })
    return json(res, 200, { ok: true })
  }

  const unverifyMatch = url.pathname.match(/^\/users\/([^/]+)\/unverify$/)
  if (method === 'POST' && unverifyMatch) {
    const targetId = unverifyMatch[1]
    const body = JSON.parse(await readBody(req))
    if (!OWNER_USER_IDS.has(body.requesterId ?? '')) return json(res, 403, { error: 'Forbidden' })
    data.verifiedUsers = data.verifiedUsers.filter(id => id !== targetId)
    const target = data.users.find(u => u.id === targetId)
    if (target && target.role === 'Verified') target.role = 'User'
    saveData(data)
    return json(res, 200, { ok: true })
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  if (method === 'GET' && url.pathname === '/messages') {
    const userId = url.searchParams.get('userId')
    const withId = url.searchParams.get('withId')
    if (!userId || !withId) return json(res, 400, { error: 'Missing params' })
    const msgs = data.messages.filter(m =>
      (m.fromId === userId && m.toId === withId) ||
      (m.fromId === withId && m.toId === userId)
    ).sort((a, b) => a.createdAt - b.createdAt)
    return json(res, 200, msgs)
  }

  if (method === 'POST' && url.pathname === '/messages') {
    const body = JSON.parse(await readBody(req))
    const msg = {
      id:         `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      fromId:     body.fromId,
      fromName:   body.fromName,
      fromAvatar: body.fromAvatar ?? '',
      toId:       body.toId,
      body:       body.body ?? '',
      createdAt:  Date.now(),
      read:       false,
    }
    data.messages.push(msg)
    saveData(data)
    broadcast('message:new', msg)
    return json(res, 201, msg)
  }

  if (method === 'GET' && url.pathname === '/messages/unread') {
    const userId = url.searchParams.get('userId')
    const unread = data.messages.filter(m => m.toId === userId && !m.read)
    return json(res, 200, { count: unread.length, messages: unread })
  }

  const readMatch = url.pathname.match(/^\/messages\/([^/]+)\/read$/)
  if (method === 'POST' && readMatch) {
    const msgId = readMatch[1]
    const msg = data.messages.find(m => m.id === msgId)
    if (msg) msg.read = true
    saveData(data)
    return json(res, 200, { ok: true })
  }

  json(res, 404, { error: 'Not found' })
}

// ── Start ─────────────────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  handleRequest(req, res).catch(e => json(res, 500, { error: String(e) }))
})

const wss = new WebSocketServer({ server: httpServer })
wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
})

httpServer.listen(PORT, () => {
  console.log(`[multiloader] Community server running on port ${PORT}`)
  console.log(`[multiloader] Data file: ${DATA_FILE}`)
})
