// icity.js - iCity 日记入口 假装做了一些修改
// 依赖：db.js, main.js, wechat.js

(function() {
  const ICITY_POSTS_PREFIX = 'wanwan_icity_posts_'

  // 日记帖子内存缓存，真实数据按微信账号(ownerUid)持久化到本地
  const icityPostsByOwner = {}

  const ICITY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const ICITY_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  function pad2(n) {
    return n < 10 ? '0' + n : String(n)
  }

  function formatICityDate(ts) {
    const d = new Date(ts)
    return {
      main: `${ICITY_MONTHS[d.getMonth()]} ${d.getDate()} · ${ICITY_DAYS[d.getDay()]}`,
      year: String(d.getFullYear()),
      time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }
  }

  // 详情页日期格式：2026-06-05 22:35
  function formatICityFullDate(ts) {
    const d = new Date(ts)
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }

  function icityEscHtml(str) {
    if (str === null || str === undefined) return ''
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function getUserBaseName(user) {
    return user?.nick || user?.name || '我'
  }

  function getInitial(name) {
    return String(name || '?').trim().charAt(0) || '?'
  }

  function avatarHTML(src, name) {
    return src
      ? `<img src="${icityEscHtml(src)}" alt="${icityEscHtml(name)}">`
      : `<span>${icityEscHtml(getInitial(name))}</span>`
  }

  function makeICityId(prefix) {
    return `${prefix || 'icity'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  function getICityDisplayName(char, profile) {
    return (profile?.remark || '').trim() || char?.nick || char?.name || '未知'
  }

  function getICityDisplayAvatar(char, profile) {
    return profile?.avatar || char?.avatar || ''
  }

  function getICityAccount(account) {
    return String(account || '').trim() || 'iCityUser'
  }

  function getICityUserPromptName(user) {
    return String(user?.nick || user?.name || '').trim() || '她'
  }

  function getICityCharPromptName(char) {
    return String(char?.nick || char?.name || '').trim() || '我'
  }

  function resolveICityPromptPlaceholders(text, ctx) {
    return String(text || '')
      .replace(/\{\{\s*(?:user|用户)\s*\}\}/gi, ctx.userName || '她')
      .replace(/\{\{\s*(?:char|角色)\s*\}\}/gi, ctx.charName || '我')
  }

  function getICityPostsKey(ownerUid) {
    return ICITY_POSTS_PREFIX + String(ownerUid || '')
  }

  function normalizeICityPosts(posts, ownerUid) {
    if (!Array.isArray(posts)) return []
    return posts
      .map(post => {
        const createdAt = Number(post?.createdAt) || Date.now()
        const authorType = post?.authorType === 'role' ? 'role' : 'self'
        const notes = Array.isArray(post?.notes) ? post.notes : []
        return {
          id: post?.id || createdAt,
          text: String(post?.text || '').trim(),
          createdAt,
          ownerUid: Number(post?.ownerUid) || Number(ownerUid) || null,
          ownerAccount: String(post?.ownerAccount || '').trim(),
          authorType,
          authorId: authorType === 'role' ? Number(post?.authorId) || null : undefined,
          liked: !!post?.liked,
          notes: notes
            .map(note => {
              const noteCreatedAt = Number(note?.createdAt) || Date.now()
              const fromType = note?.fromType === 'role' ? 'role' : 'self'
              return {
                id: note?.id || noteCreatedAt,
                comment: String(note?.comment || '').trim(),
                fromType,
                fromName: String(note?.fromName || '').trim(),
                replyToId: note?.replyToId || null,
                createdAt: noteCreatedAt
              }
            })
            .filter(note => note.comment)
            .sort((a, b) => a.createdAt - b.createdAt)
        }
      })
      .filter(post => post.text)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200)
  }

  function loadICityPosts(ownerUid) {
    if (!ownerUid) return []
    const key = getICityPostsKey(ownerUid)
    try {
      const raw = localStorage.getItem(key)
      const posts = normalizeICityPosts(raw ? JSON.parse(raw) : [], ownerUid)
      icityPostsByOwner[ownerUid] = posts
      return posts
    } catch (e) {
      console.warn('[icity] 读取本地日记失败：', e)
      return icityPostsByOwner[ownerUid] || []
    }
  }

  function saveICityPosts(ownerUid, posts) {
    if (!ownerUid) return
    const normalized = normalizeICityPosts(posts, ownerUid)
    icityPostsByOwner[ownerUid] = normalized
    try {
      localStorage.setItem(getICityPostsKey(ownerUid), JSON.stringify(normalized))
    } catch (e) {
      console.warn('[icity] 保存本地日记失败：', e)
      window.toast?.('本地保存失败，请检查浏览器存储空间')
    }
  }

  async function getWechatSelfProfileFor(uid) {
    if (!uid) return {}
    const row = await db.config.get(`wechatSelfProfile_${uid}`)
    return row?.value || {}
  }

  async function getWechatProfileFor(ownerUid, charId) {
    if (!ownerUid || !charId) return {}
    const row = await db.config.get(`wechatProfile_${ownerUid}_${charId}`)
    return row?.value || {}
  }

  async function loadICityFriendCharacters(ownerUid) {
    if (!ownerUid) return []
    const cfg = await db.config.get(`friends_${ownerUid}`)
    const ids = Array.isArray(cfg?.value) ? cfg.value : []
    if (!ids.length) return []

    const rows = await Promise.all(ids.map(async id => {
      const char = await db.characters.get(parseInt(id, 10))
      if (!char || char.type === 'user') return null
      const profile = await getWechatProfileFor(ownerUid, char.id)
      return {
        id: char.id,
        type: char.type,
        name: getICityDisplayName(char, profile),
        avatar: getICityDisplayAvatar(char, profile),
        desc: profile?.desc || char.description || ''
      }
    }))
    return rows
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  window.showICityPage = async function() {
    const existing = document.getElementById('icity-page')
    if (existing) return

    const page = document.createElement('div')
    page.id = 'icity-page'
    page.className = 'full-page miss-page'
    page.innerHTML = `
      <div class="page-header miss-header">
        <button class="header-back" id="icity-back" type="button"><i class="fa fa-angle-left"></i></button>
        <span class="header-title" id="icity-title">iCity</span>
        <button class="icity-header-action" id="icity-generate" type="button" aria-label="生成日记" hidden>
          <i class="fa-solid fa-wand-magic-sparkles"></i>
        </button>
      </div>
      <div class="miss-body" id="icity-body"></div>
    `
    page._icityState = { view: 'accounts' }
    page.querySelector('#icity-back').addEventListener('click', () => handleICityBack(page))
    page.querySelector('#icity-generate').addEventListener('click', () => showICityGenerateModal(page))
    window.openPage(page)
    await renderICityAccountPicker(page)
  }

  function setICityTitle(page, title) {
    const el = page.querySelector('#icity-title')
    if (el) el.textContent = title
  }

  function setICityGenerateVisible(page, visible) {
    const btn = page.querySelector('#icity-generate')
    if (btn) btn.hidden = !visible
  }

  function handleICityBack(page) {
    const state = page._icityState || {}
    if (state.view === 'diary') {
      removeICityFooter(page)
      renderICityAccountRows(page, page._icityAccountState?.displayItems || [])
      page._icityState = { view: 'accounts' }
      setICityTitle(page, 'iCity')
      setICityGenerateVisible(page, false)
      return
    }
    window.closePage('icity-page')
  }

  async function renderICityAccountPicker(page) {
    page._icityState = { view: 'accounts' }
    setICityTitle(page, 'iCity')
    setICityGenerateVisible(page, false)
    const body = page.querySelector('#icity-body')
    const token = (page._icityAccountLoadToken || 0) + 1
    page._icityAccountLoadToken = token
    body.innerHTML = '<div class="miss-loading"><i class="fa fa-spinner fa-spin"></i></div>'

    const users = (await db.characters.where('type').equals('user').toArray())
      .sort((a, b) => (b.id || 0) - (a.id || 0))
    if (page._icityAccountLoadToken !== token) return

    if (!users.length) {
      page._icityAccountState = { displayItems: [] }
      renderICityAccountRows(page, [])
      return
    }

    const displayItems = []
    for (const user of users) {
      const profile = await getWechatSelfProfileFor(user.id)
      displayItems.push({
        user,
        name: getUserBaseName(user),
        avatar: profile.avatar || user.avatar || ''
      })
    }
    if (page._icityAccountLoadToken !== token) return
    page._icityAccountState = { displayItems }
    renderICityAccountRows(page, displayItems)
  }

  function renderICityAccountRows(page, displayItems) {
    const body = page.querySelector('#icity-body')
    if (!body) return
    if (!displayItems.length) {
      body.innerHTML = `
        <div class="miss-empty">
          <i class="fa fa-user"></i>
          <div>暂无微信账号</div>
          <span>请先在微信里登录或创建 USER 角色</span>
        </div>`
      return
    }

    body.innerHTML = `
      <div class="miss-section-title">选择微信账号</div>
      <div class="miss-list">
        ${displayItems.map(item => `
          <button class="miss-row" data-owner-uid="${item.user.id}" type="button">
            <div class="miss-avatar">${avatarHTML(item.avatar, item.name)}</div>
            <div class="miss-row-main">
              <div class="miss-row-title">${icityEscHtml(item.name)}</div>
              <div class="miss-row-sub">${icityEscHtml(item.user.identity?.account ? '@' + item.user.identity.account : item.user.description || '微信账号')}</div>
            </div>
            <i class="fa fa-angle-right"></i>
          </button>
        `).join('')}
      </div>`
    body.querySelectorAll('.miss-row').forEach(row => {
      row.addEventListener('click', () => renderICityDiary(page, parseInt(row.dataset.ownerUid, 10)))
    })
  }

  async function renderICityDiary(page, ownerUid) {
    page._icityState = { view: 'diary', ownerUid }
    setICityTitle(page, '日记·iCity')
    setICityGenerateVisible(page, true)
    const body = page.querySelector('#icity-body')
    body.innerHTML = ''

    const item = (page._icityAccountState?.displayItems || []).find(it => it.user.id === ownerUid)
    const user = item?.user
    const profileData = await getWechatSelfProfileFor(ownerUid)
    const profile = {
      name: item ? item.name : getUserBaseName(user),
      avatar: item ? item.avatar : (profileData.avatar || user?.avatar || ''),
      account: getICityAccount(user?.identity?.account),
      bio: String(profileData.bio || '').trim()
    }
    page._icityProfile = profile
    loadICityPosts(ownerUid)
    renderICityFooter(page, profile)
    await renderICityHome(page)
  }

  async function showICityGenerateModal(page) {
    const ownerUid = page?._icityState?.ownerUid
    if (!ownerUid || document.getElementById('icity-generate-modal')) return

    const overlay = document.createElement('div')
    overlay.className = 'sheet-overlay icity-generate-overlay'
    overlay.id = 'icity-generate-overlay'

    const modal = document.createElement('div')
    modal.className = 'center-modal icity-generate-modal'
    modal.id = 'icity-generate-modal'
    modal.innerHTML = `
      <div class="icity-generate-head">
        <div class="icity-generate-title">生成日记</div>
      </div>
      <div class="icity-generate-list">
        <div class="icity-generate-loading"><i class="fa fa-spinner fa-spin"></i></div>
      </div>
      <div class="icity-generate-actions">
        <button class="icity-generate-cancel" type="button">取消</button>
        <button class="icity-generate-confirm" type="button" disabled>确认</button>
      </div>
    `

    const app = document.getElementById('app') || document.body
    app.appendChild(overlay)
    app.appendChild(modal)
    requestAnimationFrame(() => {
      overlay.classList.add('show')
      modal.classList.add('show')
    })

    const close = () => {
      overlay.classList.remove('show')
      modal.classList.remove('show')
      setTimeout(() => {
        overlay.remove()
        modal.remove()
      }, 220)
    }

    overlay.addEventListener('click', close)
    modal.querySelector('.icity-generate-cancel').addEventListener('click', close)
    modal.querySelector('.icity-generate-confirm').addEventListener('click', () => {
      const active = modal.querySelector('.icity-generate-friend.active')
      const friendId = Number(active?.dataset.friendId)
      if (!friendId) return
      runICityDiaryGeneration(page, friendId, {
        confirm: modal.querySelector('.icity-generate-confirm'),
        close
      })
    })

    const friends = await loadICityFriendCharacters(ownerUid)
    if (!document.body.contains(modal)) return
    renderICityGenerateFriendList(modal, friends)
  }

  function renderICityGenerateFriendList(modal, friends) {
    const list = modal.querySelector('.icity-generate-list')
    const confirm = modal.querySelector('.icity-generate-confirm')
    if (!list || !confirm) return
    if (!friends.length) {
      list.innerHTML = `
        <div class="icity-generate-empty">
          <i class="fa fa-user-o"></i>
          <div>暂无好友</div>
          <span>当前微信号还没有添加好友</span>
        </div>`
      confirm.disabled = true
      return
    }

    list.innerHTML = friends.map(friend => `
      <button class="icity-generate-friend" data-friend-id="${friend.id}" type="button">
        <span class="icity-generate-avatar">${avatarHTML(friend.avatar, friend.name)}</span>
        <span class="icity-generate-info">
          <span class="icity-generate-name">${icityEscHtml(friend.name)}</span>
          <span class="icity-generate-desc">${icityEscHtml(friend.desc || friend.type || '好友')}</span>
        </span>
        <i class="fa fa-circle-o icity-generate-check"></i>
      </button>
    `).join('')

    list.querySelectorAll('.icity-generate-friend').forEach(row => {
      row.addEventListener('click', () => {
        list.querySelectorAll('.icity-generate-friend').forEach(el => {
          const active = el === row
          el.classList.toggle('active', active)
          const icon = el.querySelector('.icity-generate-check')
          if (icon) icon.className = active ? 'fa fa-check-circle icity-generate-check' : 'fa fa-circle-o icity-generate-check'
        })
        confirm.disabled = false
      })
    })
  }

  async function collectICityContext(ownerUid, friendId) {
    const char = await db.characters.get(friendId)
    if (!char) throw new Error('角色不存在')
    const owner = await db.characters.get(Number(ownerUid))
    const profile = await getWechatProfileFor(ownerUid, friendId)
    const friendName = getICityDisplayName(char, profile)
    const friendAvatar = getICityDisplayAvatar(char, profile)
    const userName = getICityUserPromptName(owner)
    const charName = getICityCharPromptName(char)
    const placeholderCtx = { userName, charName }
    const persona = resolveICityPromptPlaceholders(char.description, placeholderCtx).trim()
    const charRole = String(char.role || '').trim()

    // 仅注入"绑定该角色的单人世界书"的全部启用条目（不做关键词匹配）
    const lorebooks = (await db.config.get('lorebooks'))?.value || []
    const loreEntries = []
    for (const book of lorebooks) {
      if (book.enabled === false) continue
      if (book.scope !== 'personal') continue
      const ids = (book.charIds || []).map(Number)
      if (!ids.includes(Number(friendId))) continue
      for (const entry of (book.entries || [])) {
        if (entry.enabled === false) continue
        const c = resolveICityPromptPlaceholders(entry.content, placeholderCtx).trim()
        if (c) loreEntries.push(c)
      }
    }
    const loreText = loreEntries.join('\n\n')

    let recent = []
    const chat = await db.chats.where('[ownerUid+charId]').equals([ownerUid, friendId]).first()
    if (chat) {
      const msgs = await db.messages.where('chatId').equals(chat.id).sortBy('createdAt')
      recent = msgs.slice(-30).map(m => ({
        speaker: m.role === 'user' ? '我' : friendName,
        text: resolveICityPromptPlaceholders(m.content, placeholderCtx).trim()
      })).filter(x => x.text)
    }

    const posts = loadICityPosts(ownerUid)
    const previousRolePost = posts.find(post => post.authorType === 'role' && Number(post.authorId) === Number(friendId)) || null
    const pendingNotes = previousRolePost
      ? (previousRolePost.notes || []).filter(note => {
          if (note.fromType !== 'self' || note.replyToId) return false
          return !(previousRolePost.notes || []).some(reply => reply.fromType === 'role' && String(reply.replyToId) === String(note.id))
        })
      : []
    const resolvedPendingNotes = pendingNotes.map(note => ({
      ...note,
      comment: resolveICityPromptPlaceholders(note.comment, placeholderCtx).trim()
    })).filter(note => note.comment)
    const rawUserDiary = posts.find(post =>
      post.authorType !== 'role' &&
      !(post.notes || []).some(n => n.fromType === 'role' && Number(n.fromId) === Number(friendId))
    ) || null
    const userDiary = rawUserDiary
      ? { ...rawUserDiary, text: resolveICityPromptPlaceholders(rawUserDiary.text, placeholderCtx).trim() }
      : null

    return {
      ownerUid,
      friendId,
      userName,
      charName,
      friendName,
      friendAvatar,
      persona,
      charRole,
      loreText,
      recent,
      previousRolePost,
      pendingNotes: resolvedPendingNotes,
      userDiary
    }
  }

  function buildICityPrompt(ctx) {
    const recentChat = ctx.recent.map(item => `${item.speaker}: ${item.text}`).join('\n')
    const systemPrompt = `现在你就是「${ctx.friendName}」这个人${ctx.charRole ? `，${ctx.charRole}` : ''}。这是你的设定：
${ctx.persona || '暂无额外设定。'}
${ctx.loreText ? `\n这是和你相关的背景设定（世界书），请把它当成你所处世界的事实：\n${ctx.loreText}\n` : ''}
你要写一篇今天的日记，是写给自己看的，不会给别人看。请按下面的要求写：

· 用「我」来写，也就是「${ctx.friendName}」的视角。写你心里真实想的、真实感觉到的东西。
· 像平时说话那样写，不用文绉绉的。可以用口头禅、语气词、省略号、感叹号。可以自言自语，也可以想到一件事就写一件事，顺序乱一点没关系。
· 不要写得像作文，不用讲究开头结尾和结构。就是随手记，记今天的心情和发生的小事。
· 多写具体的事，比如：今天吃了什么、出门看到了什么、和谁说了什么话、心里在想什么。不要只写空泛的感受。
· 字数 500 到 3000 字之间。想多写就多写，想少写就少写，不用硬凑字数。
· 不要在日记里写日期、星期、标题、或者「第几天」这种字。时间由系统单独记，你只写日记内容就行。
· 不要输出任何双花括号包裹的模板占位符。`

    const parts = [`请以「${ctx.friendName}」的身份，写下今天的这篇日记。`]
    if (recentChat) {
      parts.push(`【可参考的近况】（仅作灵感，别照搬聊天原文，要转成日记口吻写感受）：\n${recentChat}`)
    }

    const taskParts = []
    if (ctx.pendingNotes.length) {
      taskParts.push(`（A）下面是别人在你上一篇日记下留的小纸条，请逐条用「${ctx.friendName}」会有的口气回应，像朋友间随手回话那样自然简短：\n${ctx.pendingNotes.map(note => `  - 对方小纸条：${note.comment}`).join('\n')}`)
    }
    if (ctx.userDiary) {
      taskParts.push(`（B）这是对方写的一篇日记，读完后请你以「${ctx.friendName}」的身份给它留小纸条，就像看到朋友的日记后随手评论几句，真诚、自然、带点你自己的语气，几条都行、顺着感觉来：\n  日记内容：${ctx.userDiary.text.slice(0, 1500)}`)
    }
    if (taskParts.length) parts.push(`【附加任务】\n${taskParts.join('\n\n')}`)

    parts.push(`【输出格式】只返回下面这个 JSON，不要附加任何解释或代码块标记：
{
  "diary": "日记正文，纯文本，换行用 \\n",
  "noteReplies": ${ctx.pendingNotes.length ? '[{ "to": "对方那条小纸条的原文", "comment": "你的回应" }]' : '[]'},
  "notesForUserDiary": ${ctx.userDiary ? '[{ "comment": "你想给这篇日记留的小纸条" }]' : '[]'}
}
说明：没有附加任务时，对应的数组返回 []。日记正文里如果要引用别人说的话，请用「」，不要用英文双引号。`)

    return { systemPrompt, userPrompt: parts.join('\n\n') }
  }
  // 生成中的占位卡片
  function addICityPendingCard(page, ctx) {
    if (!page.querySelector('.icity-tab-home.active')) return null
    const body = page.querySelector('#icity-body')
    if (!body) return null
    let feed = body.querySelector('.icity-feed')
    if (!feed) {
      body.innerHTML = '<div class="icity-feed"></div>'
      feed = body.querySelector('.icity-feed')
    }
    const el = document.createElement('div')
    el.className = 'icity-post icity-post-pending'
    el.innerHTML = `
      <div class="icity-post-head">
        <span class="icity-post-avatar">${avatarHTML(ctx.friendAvatar, ctx.friendName)}</span>
        <span class="icity-post-author">
          <span class="icity-post-name">${icityEscHtml(ctx.friendName)}</span>
          <span class="icity-post-account">正在写日记…</span>
        </span>
      </div>
      <div class="icity-pending-dots"><i></i><i></i><i></i></div>`
    feed.prepend(el)
    return el
  }

  // 必须点“我已知晓”才能关闭的报错弹窗
  function showICityErrorDialog({ title, message, detail }) {
    if (document.getElementById('icity-error-modal')) return
    const overlay = document.createElement('div')
    overlay.className = 'sheet-overlay icity-generate-overlay'
    overlay.id = 'icity-error-overlay'
    const modal = document.createElement('div')
    modal.className = 'center-modal icity-generate-modal'
    modal.id = 'icity-error-modal'
    modal.innerHTML = `
      <div class="icity-generate-head"><div class="icity-generate-title">${icityEscHtml(title)}</div></div>
      <div class="icity-error-msg">${icityEscHtml(message)}</div>
      ${detail ? `<details class="icity-error-detail"><summary>查看更多</summary><pre>${icityEscHtml(detail)}</pre></details>` : ''}
      <div class="icity-generate-actions">
        <button class="icity-generate-confirm" type="button">我已知晓</button>
      </div>`
    const app = document.getElementById('app') || document.body
    app.appendChild(overlay)
    app.appendChild(modal)
    requestAnimationFrame(() => {
      overlay.classList.add('show')
      modal.classList.add('show')
    })
    modal.querySelector('.icity-generate-confirm').addEventListener('click', () => {
      overlay.classList.remove('show')
      modal.classList.remove('show')
      setTimeout(() => { overlay.remove(); modal.remove() }, 220)
    })
  }
  
  function rescueICityJSON(text) {
    const m = text.match(/"diary"\s*:\s*"([\s\S]*?)"\s*,\s*"noteReplies"\s*:/)
    if (!m) return null
    const diary = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim()
    const readArr = key => {
      const mm = text.match(new RegExp('"' + key + '"\\s*:\\s*(\\[[\\s\\S]*?\\])\\s*(?:,\\s*"|\\})'))
      if (!mm) return []
      try { return JSON.parse(mm[1]) } catch (_) { return [] }
    }
    return {
      diary,
      noteReplies: readArr('noteReplies'),
      notesForUserDiary: readArr('notesForUserDiary')
    }
  }

  function parseICityJSON(raw) {
    let text = String(raw || '').trim()
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start !== -1 && end > start) text = text.slice(start, end + 1)
    try {
      return JSON.parse(text)
    } catch (e) {
      const rescued = rescueICityJSON(text)
      if (rescued) return rescued
      const err = new Error('返回内容不是约定的 JSON 格式')
      err.isParseError = true
      err.rawOutput = String(raw || '').slice(0, 2000)
      throw err
    }
  }
  function makeICityNote(comment, fromType, fromName, replyToId, fromId) {
    const createdAt = Date.now()
    return {
      id: makeICityId('note'),
      comment: String(comment || '').trim(),
      fromType,
      fromName,
      fromId: fromId ?? null,
      replyToId: replyToId || null,
      createdAt
    }
  }

  function applyICityGenerated(ctx, data) {
    const diary = resolveICityPromptPlaceholders(data?.diary, ctx).trim()
    if (diary.length < 50) throw new Error('AI 返回的日记太短，请重试')

    const posts = loadICityPosts(ctx.ownerUid)
    const now = Date.now()
    const newPost = {
      id: makeICityId('post'),
      text: diary,
      createdAt: now,
      authorType: 'role',
      authorId: ctx.friendId,
      liked: false,
      notes: []
    }

    const previousRolePost = ctx.previousRolePost
      ? posts.find(post => String(post.id) === String(ctx.previousRolePost.id) || post.createdAt === ctx.previousRolePost.createdAt)
      : null
    const userDiary = ctx.userDiary
      ? posts.find(post => String(post.id) === String(ctx.userDiary.id) || post.createdAt === ctx.userDiary.createdAt)
      : null

    let replyCount = 0
    const replies = Array.isArray(data?.noteReplies) ? data.noteReplies : []
    if (previousRolePost && ctx.pendingNotes.length && replies.length) {
      const used = new Set()
      replies.forEach((reply, idx) => {
        const comment = resolveICityPromptPlaceholders(reply?.comment, ctx).trim()
        if (!comment) return
        const to = resolveICityPromptPlaceholders(reply?.to, ctx).trim()
        let target = null
        if (to) {
          target = ctx.pendingNotes.find(note => !used.has(String(note.id)) && note.comment === to)
            || ctx.pendingNotes.find(note => !used.has(String(note.id)) && (note.comment.includes(to) || to.includes(note.comment)))
        }
        if (!target) target = ctx.pendingNotes.find((note, noteIdx) => !used.has(String(note.id)) && noteIdx >= idx) || ctx.pendingNotes.find(note => !used.has(String(note.id)))
        if (!target) return
        previousRolePost.notes.push(makeICityNote(comment, 'role', ctx.friendName, target.id, ctx.friendId))
        used.add(String(target.id))
        replyCount += 1
      })
    }

    let userNoteCount = 0
    const userNotes = Array.isArray(data?.notesForUserDiary) ? data.notesForUserDiary : []
    if (userDiary && userNotes.length) {
      userNotes.forEach(note => {
        const comment = resolveICityPromptPlaceholders(note?.comment, ctx).trim()
        if (!comment) return
        userDiary.notes.push(makeICityNote(comment, 'role', ctx.friendName, null, ctx.friendId))
        userNoteCount += 1
      })
    }

    posts.unshift(newPost)
    saveICityPosts(ctx.ownerUid, posts)
    return { replyCount, userNoteCount }
  }

  const ICITY_TOP_POPUP_MS = 4200

  function closeICityTopMessagePopup() {
    const current = document.getElementById('icity-top-message-popup')
    if (!current) return
    clearTimeout(current._hideTimer)
    current.classList.remove('show')
    current.classList.add('is-hiding')
    setTimeout(() => current.remove(), 220)
  }

  function showICityTopMessagePopup({ title, body, avatar, open }) {
    if (document.visibilityState !== 'visible') return
    closeICityTopMessagePopup()
    const el = document.createElement('button')
    el.id = 'icity-top-message-popup'
    el.className = 'icity-top-message-popup'
    el.type = 'button'
    el.innerHTML = `
      <div class="icity-top-popup-avatar">
        ${avatarHTML(avatar, title)}
        <span class="icity-top-popup-badge"><i class="fa-solid fa-feather-pointed"></i></span>
      </div>
      <div class="icity-top-popup-body">
        <div class="icity-top-popup-meta">
          <span class="icity-top-popup-title">${icityEscHtml(title || 'iCity')}</span>
          <span class="icity-top-popup-now">NOW</span>
        </div>
        <div class="icity-top-popup-text">${icityEscHtml(body || '')}</div>
      </div>
    `
    el.addEventListener('click', async () => {
      closeICityTopMessagePopup()
      if (typeof open === 'function') await open()
    })
    document.body.appendChild(el)
    requestAnimationFrame(() => el.classList.add('show'))
    el._hideTimer = setTimeout(closeICityTopMessagePopup, ICITY_TOP_POPUP_MS)
  }

  async function runICityDiaryGeneration(page, friendId, ui) {
    const ownerUid = page?._icityState?.ownerUid
    if (!ownerUid) return
    if (!window.callAI) {
      window.toast?.('请先在设置里配置 API')
      return
    }
    if (page._icityGenerating) {
      window.toast?.('正在生成中，请稍等')
      return
    }
    page._icityGenerating = true
    ui?.close?.()

    let pending = null
    let raw = ''
    try {
      const ctx = await collectICityContext(ownerUid, friendId)
      pending = addICityPendingCard(page, ctx)
      const prompt = buildICityPrompt(ctx)
      raw = await window.callAI(
        [{ role: 'user', content: prompt.userPrompt }],
        { system: prompt.systemPrompt, temperature: await window.getAITemperaturePreset('icityDiary'), responseFormat: 'json_object' }
      )
      const data = parseICityJSON(raw)
      applyICityGenerated(ctx, data)
      pending?.remove()
      await renderICityHome(page)
      showICityTopMessagePopup({
        title: 'iCity',
        body: `${ctx.friendName}更新了1篇日记`,
        avatar: ctx.friendAvatar,
        open: () => window.showICityPage && window.showICityPage()
      })
    } catch (e) {
      pending?.remove()
      const msg = e?.message || String(e)
      let message = msg
      if (e?.isParseError) {
        message = '这个模型没有按日记格式返回内容，可以重试，或换一个模型。'
      } else if (msg.includes('API') || msg.includes('配置') || msg.includes('Base URL') || msg.includes('Key') || msg.includes('模型')) {
        message = '请先检查设置里的 API 配置。'
      }
      const rawText = e?.rawOutput || raw
      showICityErrorDialog({
        title: 'iCity 日记生成失败',
        message,
        detail: msg + (rawText ? '\n\n模型原始返回：\n' + String(rawText).slice(0, 2000) : '')
      })
    } finally {
      page._icityGenerating = false
    }
  }

  // ===== 个人主页（点击底栏头像出现） =====
  function renderICityProfileHome(page) {
    const body = page.querySelector('#icity-body')
    if (!body) return
    const profile = page._icityProfile || {}
    const ownerUid = Number(page._icityState?.ownerUid) || null
    const name = profile.name || '我'
    const account = profile.account || name
    const posts = (icityPostsByOwner[ownerUid] || loadICityPosts(ownerUid))
      .filter(post => post.authorType !== 'role' && Number(post.ownerUid) === ownerUid)
    const bioHtml = profile.bio
      ? `<div class="icity-home-bio"><i class="fa-solid fa-quote-left icity-home-quote"></i> ${icityEscHtml(profile.bio)} <i class="fa-solid fa-quote-right icity-home-quote"></i></div>`
      : ''
    const postsHtml = posts.length
      ? `<div class="icity-profile-posts">
          <div class="icity-profile-posts-title">我的日记</div>
          <div class="icity-feed icity-profile-feed">
            ${posts.map(post => icityPostHTML(post, { name, avatar: profile.avatar || '', account })).join('')}
          </div>
        </div>`
      : `<div class="miss-empty icity-profile-empty">
          <i class="fa-solid fa-feather-pointed"></i>
          <div>还没有发布日记</div>
          <span>点击中间按钮，写下第一篇个人日记</span>
        </div>`
    body.innerHTML = `
      <div class="icity-home">
        <div class="icity-home-banner"></div>
        <div class="icity-home-avatar">${avatarHTML(profile.avatar, name)}</div>
        <div class="icity-home-name">${icityEscHtml(name)}</div>
        <div class="icity-home-account">@${icityEscHtml(account)}</div>
        ${bioHtml}
        <div class="icity-home-actions">
          <button class="icity-home-btn" type="button"><i class="fa-solid fa-pen"></i>修改资料</button>
          <button class="icity-home-btn" type="button"><i class="fa-solid fa-user-group"></i>好友</button>
          <button class="icity-home-btn icity-home-btn-icon" type="button"><i class="fa-solid fa-gear"></i></button>
        </div>
      </div>
      ${postsHtml}
    `
    body.querySelectorAll('.icity-profile-feed .icity-post').forEach(el => {
      el.addEventListener('click', () => {
        const ts = Number(el.dataset.postTs)
        const post = posts.find(p => p.createdAt === ts)
        if (post) showICityPostDetail(page, post)
      })
    })
  }

  // ===== 日记·iCity 底栏 =====
  const ICITY_HOME_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M514.4 927.4c-7.5 0-15-1.9-22-5.7l-109.7-61.3c-18-10-38.3-15.3-58.9-15.3H189c-69.8 0-126.6-56.8-126.6-126.6V225.6C62.4 155.8 119.2 99 189 99h202.3c26.1 0 51.3 7.8 72.7 22.5 20.6 14.2 25.8 42.3 11.7 62.9-14.2 20.6-42.3 25.8-62.9 11.7-6.3-4.3-13.7-6.6-21.4-6.6H189c-19.9 0-36.1 16.2-36.1 36.1v492.9c0 19.9 16.2 36.1 36.1 36.1h134.7c36 0 71.6 9.3 103 26.8l109.8 61.3c21.8 12.2 29.6 39.8 17.5 61.6-8.3 14.7-23.8 23.1-39.6 23.1z"/><path d="M515.7 927.4c-15.9 0-31.3-8.4-39.6-23.2-12.2-21.8-4.4-49.4 17.5-61.6l109.8-61.3c31.4-17.5 67-26.8 103-26.8h134.7c19.9 0 36.1-16.2 36.1-36.1V225.6c0-19.9-16.2-36.1-36.1-36.1H639.4c-20.6 0-37.3 16.7-37.3 37.3v434.9c0 25-20.3 45.3-45.3 45.3s-45.3-20.3-45.3-45.3V226.9c0-70.5 57.4-127.8 127.9-127.8h201.7c69.8 0 126.6 56.8 126.6 126.6v492.9c0 69.8-56.8 126.6-126.6 126.6H706.3c-20.6 0-40.9 5.3-58.9 15.3l-109.7 61.3c-7 3.8-14.5 5.6-22 5.6zM364.7 426.7h-112c-25 0-45.3-20.3-45.3-45.3 0-25 20.3-45.3 45.3-45.3h112c25 0 45.3 20.3 45.3 45.3-0.1 25.1-20.3 45.3-45.3 45.3zM364.7 632.5h-81.2c-25 0-45.3-20.3-45.3-45.3s20.3-45.3 45.3-45.3h81.2c25 0 45.3 20.3 45.3 45.3s-20.3 45.3-45.3 45.3z"/></svg>'
  const ICITY_EDIT_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M21.19936 958.08l-12.352-12.288a30.208 30.208 0 0 1-7.296-30.912l171.008-516.032c9.344-28.352 28.864-52.16 54.784-66.944L462.22336 211.2a30.208 30.208 0 0 1 36.352 4.864l308.032 308.096c9.6 9.6 11.648 24.448 4.928 36.288l-120.448 235.2c-14.72 25.856-38.528 45.44-66.816 54.848l-515.072 171.904a30.208 30.208 0 0 1-30.976-7.296l-13.312-13.312 304.832-304.896a60.16 60.16 0 0 0 58.88-15.104 61.12 61.12 0 0 0-0.96-86.464 61.12 61.12 0 0 0-86.464-1.024 60.16 60.16 0 0 0-15.168 58.88L21.19936 958.08zM745.74336 19.648l257.472 257.408c26.24 26.24 26.24 68.736 0 94.976L901.13536 474.112a30.208 30.208 0 0 1-42.752 0L548.75136 164.48a30.208 30.208 0 0 1 0-42.752L650.83136 19.648a67.2 67.2 0 0 1 94.912 0z"/></svg>'

  // 帖子底部四个图标
  const ICITY_LIKE_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M511.7 919.4c-4.6 0-9.8-0.7-14.1-2.1-9.8-3.1-241.3-78.2-366.7-295.8C62.4 502.6 23 321.3 137.3 201.8c53.2-55.6 112.9-84.1 177.7-84.8 64.9-1.5 132.4 27.4 196.3 81.9 64-54.4 131.1-82.4 196.3-81.9 64.7 0.7 124.5 29.2 177.7 84.8 114.4 119.5 74.9 300.8 6.4 419.7-125.3 217.7-356.8 292.8-366.6 295.9-4.3 1.3-8.9 2-13.4 2zM317.5 206.3H316c-39.8 0.4-78.3 19.7-114.2 57.3-75.1 78.5-50.9 214 6.4 313.5 92.3 160.3 255.8 232.4 303 250.5 47.2-18.2 211.3-91 303.2-250.5 57.3-99.5 81.5-235 6.4-313.5-35.9-37.6-74.4-56.8-114.2-57.3h-1.5c-63.8 0-122.8 45.5-161.2 83.9-1.6 1.6-3.3 3.1-5.2 4.4-7.6 6.4-17.1 9.8-27.4 10.1-11.7 0.6-24.5-5.6-33.2-15-37.8-37.9-96.8-83.4-160.6-83.4z"/></svg>'
  const ICITY_LIKE_SOLID_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M511.7 919.4c-4.6 0-9.8-0.7-14.1-2.1-9.8-3.1-241.3-78.2-366.7-295.8C62.4 502.6 23 321.3 137.3 201.8c53.2-55.6 112.9-84.1 177.7-84.8 64.9-1.5 132.4 27.4 196.3 81.9 64-54.4 131.1-82.4 196.3-81.9 64.7 0.7 124.5 29.2 177.7 84.8 114.4 119.5 74.9 300.8 6.4 419.7-125.3 217.7-356.8 292.8-366.6 295.9-4.3 1.3-8.9 2-13.4 2z"/></svg>'
  const ICITY_COMMENT_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M830.9 98.5H190c-69.9 0-126.8 56.9-126.8 126.8v473.3c0 69.9 56.9 126.8 126.8 126.8h151.7l75.1 79.6c24 25.4 56.5 39.5 91.4 39.7h0.6c34.7 0 67.1-13.8 91.2-38.8l77.3-80.4h153.6c69.9 0 126.8-56.9 126.8-126.8V225.3c0-69.9-56.9-126.8-126.8-126.8z m37.4 600.1c0 20.6-16.8 37.4-37.3 37.4H675.8c-23.3 0-45.9 9.6-62 26.4l-78.3 81.5c-7.1 7.3-16.6 11.4-26.7 11.4h-0.2c-10.2-0.1-19.8-4.2-26.8-11.6L405.7 763c-16.2-17.2-39-27-62.6-27H190c-20.6 0-37.4-16.8-37.4-37.4V225.3c0-20.6 16.8-37.4 37.4-37.4h641c20.6 0 37.3 16.8 37.3 37.4v473.3z"/></svg>'
  const ICITY_CLOCK_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M512.7 959.8c-247 0-448-201-448-448s201-448 448-448 448 201 448 448-200.9 448-448 448z m0-806.4c-197.6 0-358.4 160.8-358.4 358.4s160.8 358.4 358.4 358.4 358.4-160.8 358.4-358.4-160.7-358.4-358.4-358.4z"/><path d="M700 576.8H512.7c-24.6 0-44.6-19.9-44.8-44.5L466 254.5c-0.2-24.7 19.8-44.9 44.5-45.1h0.3c24.6 0 44.6 19.9 44.8 44.5l1.6 233.3H700c24.7 0 44.8 20.1 44.8 44.8 0 24.7-20.1 44.8-44.8 44.8z"/></svg>'
  const ICITY_MORE_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M512 200.3m-75.7 0a75.7 75.7 0 1 0 151.4 0 75.7 75.7 0 1 0-151.4 0Z"/><path d="M512 511.9m-75.7 0a75.7 75.7 0 1 0 151.4 0 75.7 75.7 0 1 0-151.4 0Z"/><path d="M512 823.5m-75.7 0a75.7 75.7 0 1 0 151.4 0 75.7 75.7 0 1 0-151.4 0Z"/></svg>'

  function icityLikeIconHTML(liked) {
    return liked ? ICITY_LIKE_SOLID_SVG : ICITY_LIKE_SVG
  }

  function closeICityActionMenus(scope = document) {
    scope.querySelectorAll?.('.icity-action-menu').forEach(menu => menu.remove())
    scope.querySelectorAll?.('.icity-note.show-note-menu').forEach(note => note.classList.remove('show-note-menu'))
  }

  function positionICityActionMenu(menu, anchorEl) {
    const rect = anchorEl.getBoundingClientRect()
    const gap = 8
    const edge = 8
    const menuRect = menu.getBoundingClientRect()
    const left = Math.min(Math.max(rect.left, edge), Math.max(edge, window.innerWidth - menuRect.width - edge))
    const topAbove = rect.top - menuRect.height - gap
    const topBelow = rect.bottom + gap
    const top = topAbove >= edge ? topAbove : Math.min(topBelow, Math.max(edge, window.innerHeight - menuRect.height - edge))
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
  }

  async function getICityPostAuthor(post, ownerUid, fallbackProfile) {
    if (post?.authorType === 'role') {
      const char = post.authorId ? await db.characters.get(Number(post.authorId)) : null
      const profile = char ? await getWechatProfileFor(ownerUid, char.id) : {}
      const name = char ? getICityDisplayName(char, profile) : '好友'
      return {
        name,
        avatar: char ? getICityDisplayAvatar(char, profile) : '',
        account: getICityAccount(char?.identity?.account)
      }
    }

    const user = ownerUid ? await db.characters.get(Number(ownerUid)) : null
    const profile = ownerUid ? await getWechatSelfProfileFor(ownerUid) : {}
    const name = getUserBaseName(user) || fallbackProfile?.name || '我'
    return {
      name,
      avatar: profile.avatar || user?.avatar || fallbackProfile?.avatar || '',
      account: getICityAccount(user?.identity?.account || fallbackProfile?.account)
    }
  }

  function icityPostHTML(post, author) {
    const date = formatICityDate(post.createdAt)
    const noteCount = (post.notes || []).length
    const liked = !!post.liked
    return `
      <div class="icity-post" data-post-ts="${post.createdAt}">
        <div class="icity-post-head">
          <span class="icity-post-avatar">${avatarHTML(author.avatar, author.name)}</span>
          <span class="icity-post-author">
            <span class="icity-post-name">${icityEscHtml(author.name)}</span>
            <span class="icity-post-account">@${icityEscHtml(author.account)}</span>
          </span>
          <span class="icity-post-date">
            <span class="icity-post-date-main">${icityEscHtml(date.main)}</span>
            <span class="icity-post-date-year">${icityEscHtml(date.year)}</span>
          </span>
        </div>
        <div class="icity-post-content">${icityEscHtml(post.text).replace(/\n/g, '<br>')}</div>
        <div class="icity-post-actions">
          <span class="icity-post-action icity-post-like ${liked ? 'is-liked' : ''}">${icityLikeIconHTML(liked)}</span>
          <span class="icity-post-action">${ICITY_COMMENT_SVG}${noteCount ? `<span>${noteCount}</span>` : ''}</span>
          <span class="icity-post-action icity-post-time">${ICITY_CLOCK_SVG}<span>${icityEscHtml(date.time)}</span></span>
          <span class="icity-post-action">${ICITY_MORE_SVG}</span>
        </div>
      </div>`
  }

  // 首页信息流：展示当前账号发布的日记帖子
  async function renderICityHome(page) {
    const body = page.querySelector('#icity-body')
    if (!body) return
    const ownerUid = page._icityState?.ownerUid
    const profile = page._icityProfile || {}
    const posts = icityPostsByOwner[ownerUid] || loadICityPosts(ownerUid)
    if (!posts.length) {
      body.innerHTML = `
        <div class="miss-empty icity-feed-empty">
          <i class="fa-solid fa-feather-pointed"></i>
          <div>还没有日记</div>
          <span>点击下方按钮，写下第一篇城市日记</span>
        </div>`
      return
    }
    const authors = await Promise.all(posts.map(post => getICityPostAuthor(post, ownerUid, profile)))
    if (!document.body.contains(page) || page._icityState?.ownerUid !== ownerUid) return
    body.innerHTML = `<div class="icity-feed">${posts.map((p, idx) => icityPostHTML(p, authors[idx])).join('')}</div>`
    body.querySelectorAll('.icity-post').forEach(el => {
      el.addEventListener('click', () => {
        const ts = Number(el.dataset.postTs)
        const post = posts.find(p => p.createdAt === ts)
        if (post) showICityPostDetail(page, post)
      })
    })
  }

  // ===== 帖子详情页（点击信息流帖子出现） =====
  // 底部四个操作图标
  const ICITY_DETAIL_LIKE_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M511.7 919.4c-4.6 0-9.8-0.7-14.1-2.1-9.8-3.1-241.3-78.2-366.7-295.8C62.4 502.6 23 321.3 137.3 201.8c53.2-55.6 112.9-84.1 177.7-84.8 64.9-1.5 132.4 27.4 196.3 81.9 64-54.4 131.1-82.4 196.3-81.9 64.7 0.7 124.5 29.2 177.7 84.8 114.4 119.5 74.9 300.8 6.4 419.7-125.3 217.7-356.8 292.8-366.6 295.9-4.3 1.3-8.9 2-13.4 2zM317.5 206.3H316c-39.8 0.4-78.3 19.7-114.2 57.3-75.1 78.5-50.9 214 6.4 313.5 92.3 160.3 255.8 232.4 303 250.5 47.2-18.2 211.3-91 303.2-250.5 57.3-99.5 81.5-235 6.4-313.5-35.9-37.6-74.4-56.8-114.2-57.3h-1.5c-63.8 0-122.8 45.5-161.2 83.9-1.6 1.6-3.3 3.1-5.2 4.4-7.6 6.4-17.1 9.8-27.4 10.1-11.7 0.6-24.5-5.6-33.2-15-37.8-37.9-96.8-83.4-160.6-83.4z"/></svg>'
  const ICITY_DETAIL_NOTE_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M228.9 960.4c-24.9 0-49.7-7.4-70.8-21.9-34.1-23.4-54.5-62.1-54.5-103.5V191.4C103.6 122.3 159.8 66 229 66h566.7c69.1 0 125.4 56.2 125.4 125.4V835c0 41.4-20.4 80.1-54.5 103.4-34.1 23.4-77.6 28.4-116.2 13.4l-225-87.4c-8.4-3.3-17.6-3.3-26 0l-225 87.4c-14.8 5.8-30.2 8.6-45.5 8.6z m553.7-91.9c11.2 4.4 23.4 3 33.3-3.8 9.9-6.8 15.6-17.6 15.6-29.6V191.4c0-19.8-16.1-35.9-35.9-35.9H228.9c-19.8 0-35.9 16.1-35.9 35.9V835c0 12 5.7 22.9 15.6 29.6 10 6.8 22.1 8.2 33.3 3.9l225-87.4c29.2-11.4 61.5-11.4 90.7 0l225 87.4z"/><path d="M658.6 498.7H374.5c-24.7 0-44.7-20-44.7-44.7 0-24.7 20-44.7 44.7-44.7h284.1c24.7 0 44.7 20 44.7 44.7 0 24.7-20 44.7-44.7 44.7z"/><path d="M516.5 640.8c-24.7 0-44.7-20-44.7-44.7V311.9c0-24.7 20-44.7 44.7-44.7 24.7 0 44.7 20 44.7 44.7V596c0 24.7-20 44.8-44.7 44.8z"/></svg>'
  const ICITY_DETAIL_FORWARD_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M884.8 363.6c-22.9 0-41.5-18.6-41.5-41.5V220.9c0-21.9-17.8-39.7-39.7-39.7H701.3c-22.9 0-41.5-18.6-41.5-41.5s18.6-41.5 41.5-41.5h102.3c67.6 0 122.7 55 122.7 122.7v101.2c0 22.9-18.6 41.5-41.5 41.5z"/><path d="M511.9 554.9c-10.6 0-21.2-4.1-29.3-12.2-16.2-16.2-16.2-42.5 0-58.7l349.3-349.3c16.2-16.2 42.5-16.2 58.7 0 16.2 16.2 16.2 42.5 0 58.7L541.2 542.8c-8.1 8.1-18.7 12.1-29.3 12.1z"/><path d="M511.3 928.2c-228.8 0-415-186.2-415-415s186.2-415 415-415c22.9 0 41.5 18.6 41.5 41.5s-18.6 41.5-41.5 41.5c-183.1 0-332 148.9-332 332s148.9 332 332 332 332-148.9 332-332c0-22.9 18.6-41.5 41.5-41.5s41.5 18.6 41.5 41.5c0 228.8-186.1 415-415 415z"/></svg>'
  const ICITY_DETAIL_MORE_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M507.7 512.9m-75.7 0a75.7 75.7 0 1 0 151.4 0 75.7 75.7 0 1 0-151.4 0Z"/><path d="M201.3 512.9m-75.7 0a75.7 75.7 0 1 0 151.4 0 75.7 75.7 0 1 0-151.4 0Z"/><path d="M812.3 512.9m-75.7 0a75.7 75.7 0 1 0 151.4 0 75.7 75.7 0 1 0-151.4 0Z"/></svg>'

  async function showICityPostDetail(page, post) {
    const existing = document.getElementById('icity-detail')
    if (existing) return
    const profile = page._icityProfile || {}
    const author = await getICityPostAuthor(post, page?._icityState?.ownerUid, profile)
    const titleName = author.name || profile.name || '我'

    const detail = document.createElement('div')
    detail.id = 'icity-detail'
    detail.className = 'full-page miss-page icity-detail-page'
    detail.innerHTML = `
      <div class="page-header miss-header">
        <button class="header-back" id="icity-detail-back" type="button"><i class="fa fa-angle-left"></i></button>
        <span class="header-title">${icityEscHtml(titleName)}·日记</span>
      </div>
      <div class="miss-body icity-detail-body" id="icity-detail-body">
      </div>
    `
    window.openPage(detail)
    renderICityPostDetailBody(page, detail, post)
    detail.querySelector('#icity-detail-back').addEventListener('click', () => {
      window.closePage('icity-detail')
    })
  }

  function findICityPost(ownerUid, postId, createdAt) {
    const posts = loadICityPosts(ownerUid)
    return posts.find(p => String(p.id) === String(postId)) || posts.find(p => p.createdAt === createdAt) || null
  }

  async function renderICityPostDetailBody(page, detail, post) {
    const body = detail.querySelector('#icity-detail-body')
    if (!body) return
    const profile = page._icityProfile || {}
    const ownerUid = page?._icityState?.ownerUid
    const current = findICityPost(ownerUid, post.id, post.createdAt) || post
    const author = await getICityPostAuthor(post, ownerUid, profile)
    if (!document.body.contains(detail)) return
    const liked = !!current.liked
    body.innerHTML = `
        <div class="icity-detail-card">
          <div class="icity-detail-head">
            <span class="icity-detail-avatar">${avatarHTML(author.avatar, author.name)}</span>
            <span class="icity-detail-author">
              <span class="icity-detail-name">${icityEscHtml(author.name)}</span>
              <span class="icity-detail-account">@${icityEscHtml(author.account)}</span>
            </span>
          </div>
          <div class="icity-detail-content">${icityEscHtml(current.text).replace(/\n/g, '<br>')}</div>
          <div class="icity-detail-time">
            <span class="icity-detail-time-icon">${ICITY_CLOCK_SVG}</span>
            <span>${icityEscHtml(formatICityFullDate(current.createdAt))}</span>
          </div>
        </div>
        ${renderICityNotes(current)}
        <div class="icity-detail-actions">
          <button class="icity-detail-action icity-detail-like ${liked ? 'is-liked' : ''}" type="button" data-icity-like>${icityLikeIconHTML(liked)}<span>${liked ? '已喜欢' : '喜欢'}</span></button>
          <span class="icity-detail-divider"></span>
          <button class="icity-detail-action" type="button" data-icity-note-root>${ICITY_DETAIL_NOTE_SVG}<span>小纸条</span></button>
          <span class="icity-detail-divider"></span>
          <button class="icity-detail-action" type="button">${ICITY_DETAIL_FORWARD_SVG}<span>转发</span></button>
          <span class="icity-detail-divider"></span>
          <button class="icity-detail-action icity-detail-action-more" type="button" data-icity-more>${ICITY_DETAIL_MORE_SVG}</button>
        </div>
    `
    body.querySelector('[data-icity-like]')?.addEventListener('click', () => {
      toggleICityPostLike(page, detail, current)
    })
    body.querySelector('[data-icity-note-root]')?.addEventListener('click', () => {
      showICityNoteInput(page, detail, current, null)
    })
    body.querySelector('[data-icity-more]')?.addEventListener('click', e => {
      showICityPostMoreMenu(e.currentTarget, page, detail, current)
    })
    body.querySelectorAll('[data-icity-reply-note]').forEach(btn => {
      btn.addEventListener('click', () => {
        showICityNoteInput(page, detail, current, btn.dataset.icityReplyNote)
      })
    })
    bindICityNoteLongPress(page, detail, current)
  }

  function renderICityNotes(post) {
    const notes = Array.isArray(post.notes) ? post.notes : []
    if (!notes.length) return ''
    const notesById = new Map()
    notes.forEach(note => {
      if (note?.id !== undefined && note?.id !== null) notesById.set(String(note.id), note)
    })
    const noteName = note => note?.fromName || (note?.fromType === 'role' ? '好友' : '我')
    const noteMetaHTML = note => {
      const name = noteName(note)
      const parent = note.replyToId ? notesById.get(String(note.replyToId)) : null
      if (!parent) return icityEscHtml(name)
      return `${icityEscHtml(name)} <span class="icity-note-reply-word">回复</span> ${icityEscHtml(noteName(parent))}：${icityEscHtml(parent.comment || '')}`
    }
    const renderNote = note => `
      <div class="icity-note" data-icity-note-id="${icityEscHtml(note.id)}">
        <div class="icity-note-main">
          <div class="icity-note-meta">
            <span>${noteMetaHTML(note)}</span>
            <button type="button" data-icity-reply-note="${icityEscHtml(note.id)}">回复</button>
          </div>
          <div class="icity-note-comment">${icityEscHtml(note.comment)}</div>
        </div>
        <div class="icity-note-action-menu" aria-hidden="true">
          <button type="button" data-icity-note-action="copy">复制</button>
          <button type="button" data-icity-note-action="delete">删除</button>
        </div>
      </div>`
    return `
      <div class="icity-notes">
        <div class="icity-notes-title">小纸条</div>
        ${notes.map(note => renderNote(note)).join('')}
      </div>`
  }

  function updateICityPost(ownerUid, postId, createdAt, updater) {
    const posts = loadICityPosts(ownerUid)
    let updated = null
    const next = posts.map(item => {
      const matched = String(item.id) === String(postId) || item.createdAt === createdAt
      if (!matched) return item
      updated = updater({ ...item, notes: Array.isArray(item.notes) ? item.notes.slice() : [] }) || item
      return updated
    })
    if (updated) saveICityPosts(ownerUid, next)
    return updated
  }

  async function toggleICityPostLike(page, detail, post) {
    const ownerUid = page?._icityState?.ownerUid
    const updated = updateICityPost(ownerUid, post.id, post.createdAt, item => ({
      ...item,
      liked: !item.liked
    }))
    if (!updated) return
    await renderICityPostDetailBody(page, detail, updated)
    await renderICityHome(page)
  }

  function showICityPostMoreMenu(anchorEl, page, detail, post) {
    closeICityActionMenus()
    const menu = document.createElement('div')
    menu.className = 'icity-action-menu icity-more-menu'
    menu.innerHTML = '<button type="button" data-action="delete"><i class="fa fa-trash"></i><span>删除</span></button>'
    ;(document.getElementById('app') || document.body).appendChild(menu)
    positionICityActionMenu(menu, anchorEl)
    menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      menu.remove()
      await deleteICityPost(page, detail, post)
    })
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 100)
  }

  async function deleteICityPost(page, detail, post) {
    const ownerUid = page?._icityState?.ownerUid
    const posts = loadICityPosts(ownerUid)
    const next = posts.filter(item => !(String(item.id) === String(post.id) || item.createdAt === post.createdAt))
    saveICityPosts(ownerUid, next)
    window.closePage?.(detail?.id || 'icity-detail')
    await renderICityHome(page)
    window.toast?.('日记已删除')
  }

  function bindICityNoteLongPress(page, detail, post) {
    const body = detail.querySelector('#icity-detail-body')
    if (!body) return
    let timer = null
    let start = null
    const clear = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      start = null
    }

    body.querySelectorAll('.icity-note').forEach(noteEl => {
      noteEl.addEventListener('pointerdown', e => {
        if (e.target.closest('[data-icity-reply-note]') || e.target.closest('[data-icity-note-action]')) return
        if (e.button !== undefined && e.button !== 0) return
        const noteId = e.currentTarget.dataset.icityNoteId
        if (!noteId) return
        e.preventDefault()
        clear()
        start = { x: e.clientX, y: e.clientY, noteId, row: e.currentTarget }
        timer = setTimeout(() => {
          showICityNoteActionMenu(start.row, detail)
          timer = null
        }, 520)
      })
      noteEl.addEventListener('pointermove', e => {
        if (!start) return
        const dx = Math.abs(e.clientX - start.x)
        const dy = Math.abs(e.clientY - start.y)
        if (dx > 8 || dy > 8) clear()
      })
      noteEl.addEventListener('pointerup', clear)
      noteEl.addEventListener('pointercancel', clear)
      noteEl.addEventListener('contextmenu', e => {
        e.preventDefault()
        if (!e.target.closest('[data-icity-reply-note]') && !e.target.closest('[data-icity-note-action]')) {
          showICityNoteActionMenu(e.currentTarget, detail)
        }
      })
    })

    body.querySelectorAll('[data-icity-note-action]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation()
        const noteEl = e.currentTarget.closest('.icity-note')
        const noteId = noteEl?.dataset.icityNoteId
        const note = (post.notes || []).find(item => String(item.id) === String(noteId))
        closeICityActionMenus(detail)
        if (!noteId || !note) return
        if (e.currentTarget.dataset.icityNoteAction === 'copy') await copyICityNote(note.comment)
        if (e.currentTarget.dataset.icityNoteAction === 'delete') await deleteICityNote(page, detail, post, noteId)
      })
    })

    body.querySelector('.icity-notes')?.addEventListener('selectstart', e => {
      if (e.target.closest('.icity-note')) e.preventDefault()
    })
  }

  function showICityNoteActionMenu(noteEl, detail) {
    closeICityActionMenus(detail)
    noteEl.classList.add('show-note-menu')
    setTimeout(() => document.addEventListener('click', () => closeICityActionMenus(detail), { once: true }), 100)
  }

  async function copyICityNote(text) {
    const value = String(text || '')
    try {
      await navigator.clipboard.writeText(value)
      window.toast?.('已复制')
    } catch (_) {
      const input = document.createElement('textarea')
      input.value = value
      input.style.position = 'fixed'
      input.style.left = '-9999px'
      document.body.appendChild(input)
      input.select()
      const ok = document.execCommand?.('copy')
      input.remove()
      window.toast?.(ok ? '已复制' : '复制失败')
    }
  }

  async function deleteICityNote(page, detail, post, noteId) {
    const ownerUid = page?._icityState?.ownerUid
    const updated = updateICityPost(ownerUid, post.id, post.createdAt, item => {
      const idsToDelete = new Set([String(noteId)])
      let changed = true
      while (changed) {
        changed = false
        ;(item.notes || []).forEach(note => {
          if (note.replyToId && idsToDelete.has(String(note.replyToId)) && !idsToDelete.has(String(note.id))) {
            idsToDelete.add(String(note.id))
            changed = true
          }
        })
      }
      return {
        ...item,
        notes: (item.notes || []).filter(note => !idsToDelete.has(String(note.id)))
      }
    })
    if (!updated) return
    await renderICityPostDetailBody(page, detail, updated)
    await renderICityHome(page)
    window.toast?.('小纸条已删除')
  }

  function showICityNoteInput(page, detail, post, replyToId) {
    if (document.getElementById('icity-note-modal')) return
    const overlay = document.createElement('div')
    overlay.className = 'sheet-overlay icity-note-overlay'
    overlay.id = 'icity-note-overlay'
    const modal = document.createElement('div')
    modal.className = 'center-modal icity-note-modal'
    modal.id = 'icity-note-modal'
    modal.innerHTML = `
      <div class="icity-note-modal-title">${replyToId ? '回复小纸条' : '写小纸条'}</div>
      <textarea class="icity-note-input" placeholder="写一句小纸条…"></textarea>
      <div class="icity-note-actions">
        <button class="icity-note-cancel" type="button">取消</button>
        <button class="icity-note-send" type="button" disabled>发送</button>
      </div>
    `
    const app = document.getElementById('app') || document.body
    app.appendChild(overlay)
    app.appendChild(modal)
    requestAnimationFrame(() => {
      overlay.classList.add('show')
      modal.classList.add('show')
    })
    const close = () => {
      overlay.classList.remove('show')
      modal.classList.remove('show')
      setTimeout(() => {
        overlay.remove()
        modal.remove()
      }, 220)
    }
    const input = modal.querySelector('.icity-note-input')
    const send = modal.querySelector('.icity-note-send')
    input.addEventListener('input', () => {
      send.disabled = !input.value.trim()
    })
    overlay.addEventListener('click', close)
    modal.querySelector('.icity-note-cancel').addEventListener('click', close)
    send.addEventListener('click', () => {
      addICityNote(page, detail, post, input.value.trim(), replyToId)
      close()
    })
    setTimeout(() => input.focus(), 260)
  }

  async function addICityNote(page, detail, post, comment, replyToId) {
    if (!comment) return
    const ownerUid = page?._icityState?.ownerUid
    const current = findICityPost(ownerUid, post.id, post.createdAt)
    if (!current) {
      window.toast?.('日记不存在')
      return
    }
    const profile = page._icityProfile || {}
    current.notes = Array.isArray(current.notes) ? current.notes : []
    current.notes.push(makeICityNote(comment, 'self', profile.name || '我', replyToId || null))
    const posts = loadICityPosts(ownerUid).map(item => (
      String(item.id) === String(current.id) || item.createdAt === current.createdAt ? current : item
    ))
    saveICityPosts(ownerUid, posts)
    const fresh = findICityPost(ownerUid, current.id, current.createdAt)
    if (fresh) renderICityPostDetailBody(page, detail, fresh)
    renderICityHome(page)
    window.toast?.('小纸条已送达')
  }

  function removeICityFooter(page) {
    const footer = page.querySelector('#icity-footer')
    if (footer) footer.remove()
  }

  function renderICityFooter(page, profile) {
    removeICityFooter(page)
    const footer = document.createElement('div')
    footer.id = 'icity-footer'
    footer.className = 'icity-footer'
    footer.innerHTML = `
      <button class="icity-tab icity-tab-home active" data-icity-tab="home" type="button">
        <span class="icity-tab-icon">${ICITY_HOME_SVG}</span>
        <span class="icity-tab-dot"></span>
      </button>
      <button class="icity-tab icity-tab-edit" data-icity-tab="edit" type="button">
        <span class="icity-edit-circle">${ICITY_EDIT_SVG}</span>
      </button>
      <button class="icity-tab icity-tab-profile" data-icity-tab="profile" type="button">
        <span class="icity-tab-avatar">${avatarHTML(profile.avatar, profile.name)}</span>
        <span class="icity-tab-dot"></span>
      </button>
    `
    page.appendChild(footer)

    footer.querySelectorAll('[data-icity-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.icityTab
        if (tab === 'edit') {
          showICityCompose(page)
          return
        }
        footer.querySelectorAll('.icity-tab-home, .icity-tab-profile')
          .forEach(el => el.classList.toggle('active', el === btn))
        const body = page.querySelector('#icity-body')
        if (tab === 'profile') {
          renderICityProfileHome(page)
        } else if (body) {
          renderICityHome(page)
        }
      })
    })
  }

  // ===== 发帖页面（点击底栏编辑按钮出现，暂时只做页面与交互） =====
  function showICityCompose(page) {
    const existing = document.getElementById('icity-compose')
    if (existing) return
    const profile = page?._icityProfile || {}
    const name = profile.name || '我'
    const account = profile.account || name

    const compose = document.createElement('div')
    compose.id = 'icity-compose'
    compose.className = 'full-page sub-page icity-compose-page'
    compose.innerHTML = `
      <div class="icity-compose-header">
        <button class="icity-compose-cancel" type="button">取消</button>
        <span class="icity-compose-title">写日记</span>
        <button class="icity-compose-send" type="button"><svg class="icity-compose-send-icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M1023.200312 43.682936L877.057399 920.640375c-1.899258 10.995705-8.096837 19.592347-18.292854 25.689965-5.29793 2.898868-11.295588 4.598204-17.693089 4.598204-4.19836 0-8.796564-0.99961-13.69465-2.898868l-236.707536-96.762202c-12.994924-5.29793-27.889106-1.499414-36.785631 9.296368l-123.251855 150.341273c-6.897306 8.796564-16.293635 13.094885-27.989066 13.094885-4.898087 0-9.096447-0.799688-12.695041-2.299102-7.197189-2.698946-12.994924-6.997267-17.393206-13.394768-4.398282-6.29754-6.697384-13.194846-6.697384-20.891839V811.083171c0-14.794221 5.098009-28.988676 14.394377-40.484186l478.912925-587.070676-602.864506 521.796174c-4.598204 3.898477-10.995705 4.998048-16.493557 2.698945L23.390863 619.358063C9.296369 614.060133 1.599375 603.664194 0.599766 587.870363c-0.799688-15.194065 5.29793-26.489652 18.292854-33.786802L968.921515 5.997657c5.797735-3.498633 11.795392-5.098009 18.292854-5.098008 7.696993 0 14.594299 2.199141 20.691918 6.397501 12.695041 8.996486 17.593128 21.291683 15.294025 36.385786z"/></svg>发送</button>
      </div>
      <div class="icity-compose-body">
        <div class="icity-compose-user">
          <span class="icity-compose-avatar">${avatarHTML(profile.avatar, name)}</span>
          <span class="icity-compose-userinfo">
            <span class="icity-compose-name">${icityEscHtml(name)}</span>
            <span class="icity-compose-account">@${icityEscHtml(account)}</span>
          </span>
        </div>
        <textarea class="icity-compose-input" placeholder="记录此刻，写下你的城市日记…"></textarea>
      </div>
      <div class="icity-compose-footer">
        <span class="icity-compose-hint"><i class="fa-solid fa-feather-pointed"></i> 日记·iCity</span>
      </div>
    `
    window.openPage(compose)

    const input = compose.querySelector('.icity-compose-input')
    const sendBtn = compose.querySelector('.icity-compose-send')
    const syncSend = () => {
      const hasText = input.value.trim().length > 0
      sendBtn.classList.toggle('is-active', hasText)
    }
    input.addEventListener('input', syncSend)
    syncSend()
    setTimeout(() => input.focus(), 320)

    compose.querySelector('.icity-compose-cancel').addEventListener('click', () => {
      window.closePage('icity-compose')
    })

    sendBtn.addEventListener('click', () => {
      const text = input.value.trim()
      if (!text) return
      const ownerUid = page._icityState?.ownerUid
      const list = loadICityPosts(ownerUid)
      const now = Date.now()
      saveICityPosts(ownerUid, [{
        id: makeICityId('post'),
        text,
        createdAt: now,
        ownerUid: Number(ownerUid) || null,
        ownerAccount: account,
        authorType: 'self',
        liked: false,
        notes: []
      }].concat(list))
      window.closePage('icity-compose')
      // 回到首页并切换到首页标签，刷新信息流
      const footer = page.querySelector('#icity-footer')
      if (footer) {
        footer.querySelectorAll('.icity-tab-home, .icity-tab-profile')
          .forEach(el => el.classList.toggle('active', el.classList.contains('icity-tab-home')))
      }
      renderICityHome(page)
    })
  }
})()
