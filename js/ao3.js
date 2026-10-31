// ao3.js — 同人文站（AO3 风格）
// 依赖：db.js、main.js（openPage / closePage / toast）、settings.js（window.callAI）
// 生成格式：不用 JSON。第一段是几行「键：值」的元信息，每章用 ===第N章｜标题=== 分隔，
// 结尾用 ===NEXT=== 给出 3 条续写方向。这样正文里的引号、换行不会再把解析搞坏，
// 输出被截断时已经写完的章节也能保住。
;(function () {
  'use strict'

  const STORE_KEY = 'ao3Store'
  const FANDOMS = ['原创', '原耽', '动漫', '影视', '游戏', 'RPF']
  const RATINGS = [
    { id: 'g', name: '全年龄向' },
    { id: 't', name: '青少年及以上' },
    { id: 'm', name: '成熟向' },
    { id: 'e', name: '限制级' }
  ]
  // 归档警告只作为标签使用
  const WARNINGS = ['无归档警告适用', '详细描写暴力', '主要角色死亡', '未成年相关','非自愿性描写', '选择不使用归档警告']
  const CATS = ['无CP / Gen', '男男', '女女', '男女', '多人', '其他']
  const THEME_GROUPS = [
    { id: 'world', name: '世界观', options: ['校园', '现代都市', '古代', '穿越', '仙侠', '末日', '职场', '娱乐圈', '科幻', '悬疑', '西幻'] },
    { id: 'ending', name: '结局', options: ['HE', 'OE', 'BE', '开放结局', '未完待续'] },
    { id: 'tone', name: '基调', options: ['甜', '虐', '轻松', '沉重', '搞笑', '治愈', '刀糖并存'] },
    { id: 'arc', name: '关系走向', options: ['先婚后爱', '破镜重圆', '青梅竹马', '欢喜冤家', '陌生人', '上下级'] },
    { id: 'plot', name: '叙事元素', options: ['日常', '重生', '时间循环', '群像', '双强', '追妻火葬场', '养成'] }
  ]
  const WORDS = [800, 1200, 1500, 2000]
  const CHAPTER_COUNTS = [1, 2, 3]

  let store = null
  let busy = false
  const progressText = {}

  // ===== 小工具 =====
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }
  function ratingName(id) { const r = RATINGS.find(x => x.id === id); return r ? r.name : '全年龄向' }
  function charName(c) { return (c && (c.nick || c.name)) || '角色' }
  function wordCount(text) { return String(text || '').replace(/\s/g, '').length }
  function workWords(w) { return (w.chapters || []).reduce((n, c) => n + wordCount(c.body), 0) }

  async function load() {
    if (store) return store
    let v = null
    try { v = (await db.config.get(STORE_KEY))?.value } catch (_) {}
    store = v && typeof v === 'object' ? v : {}
    if (!Array.isArray(store.works)) store.works = []
    if (!Array.isArray(store.bookmarks)) store.bookmarks = []
    if (!Array.isArray(store.kudos)) store.kudos = []
    if (typeof store.seq !== 'number') store.seq = 1
    // 上次生成到一半就被关掉的作品：标记为失败，可以重试
    store.works.forEach(w => {
      if (w.status === 'generating') { w.status = (w.chapters && w.chapters.length) ? 'ready' : 'failed'; w.failReason = '上次生成被中断，请重试' }
      w.continuing = false
      if (w.id >= store.seq) store.seq = w.id + 1
    })
    return store
  }
  async function persist() {
    try { await db.config.put({ key: STORE_KEY, value: store }) } catch (e) { console.warn('[ao3] 保存失败', e) }
  }
  function getWork(id) { return store.works.find(w => w.id === id) || null }

  // ===== 正文处理 =====
  function normalizeBody(text) {
    let s = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (/\\n/.test(s)) s = s.replace(/\\n/g, '\n').replace(/\\t/g, ' ')
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n')
    if (s.indexOf('\n') < 0 && s.length > 180) s = s.replace(/([。！？…—”」』])\s*/g, '$1\n\n')
    return s.trim()
  }
  function bodyHTML(text) {
    let h = esc(normalizeBody(text))
    h = h.replace(/“([^”\n]*)”/g, '<span class="ao3-say">“$1”</span>')
    h = h.replace(/（([^）\n]*)）/g, '<span class="ao3-think">（$1）</span>')
    h = h.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    h = h.replace(/〔([^〕\n]*)〕/g, '<span class="ao3-env">〔$1〕</span>')
    return h
  }

  // 解析：元信息 + 章节 + 续写方向
  function parseGenerated(raw) {
    const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').replace(/```[a-zA-Z]*\n?/g, '')
    const re = /^[ \t]*={3,}[ \t]*(.+?)[ \t]*={3,}[ \t]*$/gm
    const marks = []
    let m
    while ((m = re.exec(text))) marks.push({ head: m[1].trim(), start: m.index, end: re.lastIndex })
    const meta = { title: '', summary: '', relationship: '', tags: [] }
    const chapters = []
    let next = []
    const parseMetaLines = block => {
      block.split('\n').forEach(line => {
        const mm = line.match(/^\s*(标题|摘要|关系|标签)\s*[：:]\s*(.*)$/)
        if (!mm) return
        const v = mm[2].trim()
        if (mm[1] === '标题') meta.title = v.slice(0, 60)
        else if (mm[1] === '摘要') meta.summary = v.slice(0, 400)
        else if (mm[1] === '关系') meta.relationship = v.slice(0, 80)
        else meta.tags = v.split(/[、,，;；]/).map(t => t.trim()).filter(Boolean).slice(0, 12)
      })
    }
    if (!marks.length) {
      const plain = normalizeBody(text)
      return plain ? { meta, chapters: [{ title: '第 1 章', body: plain }], next } : null
    }
    marks.forEach((mk, i) => {
      const block = text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : text.length)
      if (/^META$/i.test(mk.head) || /^元信息$/.test(mk.head)) {
        parseMetaLines(block)
      } else if (/^NEXT$/i.test(mk.head) || /^续写方向$/.test(mk.head)) {
        next = block.split('\n').map(l => l.replace(/^\s*(方向\s*[一二三123]\s*[：:.、]?|\d+\s*[.、：:)）]|[-·•*])\s*/, '').trim())
          .filter(Boolean).map(l => l.slice(0, 100)).slice(0, 3)
      } else {
        const cm = mk.head.match(/^第?\s*(\d+)\s*章\s*[｜|:：\-—]?\s*(.*)$/)
        const body = normalizeBody(block)
        if (cm && body) {
          const t = (cm[2] || '').trim()
          chapters.push({ no: Number(cm[1]), title: t ? ('第 ' + cm[1] + ' 章 · ' + t).slice(0, 50) : '第 ' + cm[1] + ' 章', body })
        }
      }
    })
    if (!chapters.length) {
      // 没有章节标记：把元信息之外的内容当作一章
      const firstChapterStart = marks.length ? marks[marks.length - 1].end : 0
      const rest = normalizeBody(text.slice(firstChapterStart))
      if (rest) chapters.push({ no: 1, title: '第 1 章', body: rest })
    }
    return chapters.length ? { meta, chapters, next } : null
  }

  // ===== 提示词 =====
  function userCenteredRule(userName, charNames) {
    return `【主角与关系中心（必须遵守）】\n用户角色「${userName}」是贯穿全文的主角和关系中心，所选角色（${charNames.join('、')}）每一位都必须与「${userName}」有具体的互动和各自的关系发展。多选角色的意思是“这些人和${userName}的故事”，不要擅自把角色之间配成 CP，也不要把${userName}写成路人或只在开头出现。每章都要承接${userName}的参与。无 CP 分类写以${userName}为中心的友情或群像。`
  }

  async function buildContext(work) {
    const user = await db.characters.get(work.ownerUid)
    const chars = []
    for (const id of work.charIds) {
      const c = await db.characters.get(id)
      if (c) chars.push(c)
    }
    const userName = (user && (user.nick || user.name)) || '用户'
    const charBlocks = chars.map(c => `【角色：${charName(c)}】\n${c.description || '（未设定）'}`).join('\n\n')
    let lore = ''
    try {
      if (window.getLorebookContext && chars[0]) {
        lore = await window.getLorebookContext(chars[0].id, [{ role: 'user', content: [work.prompt, work.fandom, (work.themeLines || []).join(' ')].join('\n') }]) || ''
      }
    } catch (_) {}
    return { user, userName, chars, charNames: chars.map(charName), charBlocks, lore }
  }

  function systemPrompt(mode, ctx, work, chapN, per, startNo) {
    const themeText = (work.themeLines || []).length ? work.themeLines.join('；') : '不限（由你合理发挥）'
    const formatRule =
      '输出格式（严格遵守，不要用 JSON，不要用 Markdown 代码块，不要任何额外说明）：\n' +
      (mode === 'new'
        ? '===META===\n标题：作品标题（30字内）\n摘要：80～200字的摘要\n关系：关系标签，如“甲 / 乙”\n标签：3～8个附加标签，用顿号分隔\n'
        : '') +
      Array.from({ length: chapN }, (_, i) => `===第${startNo + i}章｜本章标题===\n（这一章的正文）`).join('\n') +
      '\n===NEXT===\n方向一：（20～40字的后续续写主旨）\n方向二：（与上一条不同）\n方向三：（与前两条不同）\n'
    return `你是一位同人小说作者，为「Archive of Our Own」风格的同人站供稿。所有出场人物都是成年人。\n` +
      formatRule +
      `\n正文要求：中文；每章约 ${per} 字（可上下浮动 15%）；含对话与场景；符合评级与归档警告；角色言行贴合各自设定；章节之间情节连贯。\n` +
      `排版：自然分段，段落之间空一行；台词放在中文引号“ ”里；心理活动放在（ ）里；强调用 *星号*；场景转换可用〔 〕。` +
      (mode === 'continue' ? `\n这是续写：紧接上一章的剧情，不要复述旧章；本次续写必须围绕用户选定的「生成方向」展开。` : '') +
      `\n你在这一次回复里写完全部章节，不要拆成多次。\n` +
      userCenteredRule(ctx.userName, ctx.charNames) +
      (ctx.lore ? `\n\n【世界观参考】\n${ctx.lore}` : '') +
      `\n\n主题方向：${themeText}`
  }

  function userPrompt(mode, ctx, work, chapN, per, startNo, direction) {
    const head =
      `领域：${work.fandom}\n评级：${work.rating}\n归档警告：${work.warning}\n分类：${work.category}\n` +
      `登场：${[ctx.userName].concat(ctx.charNames).join('、')}\n每章字数：约 ${per} 字\n` +
      (work.prompt ? `创作备注：${work.prompt}\n` : '') +
      `\n【用户角色：${ctx.userName}】\n${(ctx.user && ctx.user.description) || '（未设定）'}\n\n${ctx.charBlocks}\n`
    if (mode === 'new') {
      return head + `\n请自行拟定标题、关系、标签与摘要，并一次性写出全部 ${chapN} 章，最后给出 3 条续写方向。按系统提示的格式输出。`
    }
    const chaps = work.chapters || []
    const titles = chaps.map((c, i) => `${i + 1}. ${c.title}`).join('\n')
    const last = chaps[chaps.length - 1]
    let tail = last ? normalizeBody(last.body) : ''
    if (tail.length > 2800) tail = '…' + tail.slice(-2800)
    return `作品标题：${work.title}\n摘要：${work.summary || ''}\n关系：${work.relationship || ''}\n` + head +
      `\n【已有章节目录】\n${titles}\n\n【上一章全文】\n${tail}\n\n` +
      `【本次选定的生成方向（必须作为续写主旨）】${direction}\n\n请从第 ${startNo} 章起，一次性续写 ${chapN} 章，最后给出 3 条新的续写方向。按系统提示的格式输出。`
  }

  // ===== 生成 =====
  async function generate(workId, mode, opts) {
    opts = opts || {}
    const work = getWork(workId)
    if (!work) return
    if (busy) { window.toast?.('正在生成，请稍候'); return }
    if (typeof window.callAI !== 'function') { window.toast?.('请先在设置里配置 API'); return }
    busy = true
    const isContinue = mode === 'continue'
    const chapN = isContinue ? opts.chapN : work.chapterCount
    const per = work.wordsPerChapter || 1500
    const startNo = isContinue ? (work.chapters.length + 1) : 1
    if (isContinue) work.continuing = true
    else { work.status = 'generating'; work.failReason = '' }
    progressText[workId] = '正在等待接口返回，较长的文章可能需要几分钟…'
    await persist()
    refreshReaderIfOpen(workId)
    refreshList()
    try {
      const ctx = await buildContext(work)
      const raw = await window.callAI([{ role: 'user', content: userPrompt(mode, ctx, work, chapN, per, startNo, opts.direction) }], {
        system: systemPrompt(mode, ctx, work, chapN, per, startNo),
        temperature: 0.85
      })
      const parsed = parseGenerated(raw)
      if (!parsed || !parsed.chapters.length) {
        window._lastAo3Raw = String(raw || '')
        throw new Error('模型返回内容无法解析，请重试')
      }
      const chaps = parsed.chapters.slice(0, chapN).map((c, i) => {
        const no = startNo + i
        let title = c.title
        if (!/^第\s*\d+\s*章/.test(title)) title = '第 ' + no + ' 章 · ' + title
        return { title: title.replace(/^第\s*\d+\s*章/, '第 ' + no + ' 章'), body: c.body }
      })
      if (isContinue) {
        work.chapters = (work.chapters || []).concat(chaps)
        work.continuing = false
      } else {
        work.chapters = chaps
        work.title = parsed.meta.title || ((ctx.charNames.slice(0, 2).join('·') + ' · 同人') || '未命名作品')
        work.summary = parsed.meta.summary || (chaps[0].body.replace(/\s+/g, ' ').slice(0, 120) + '…')
        work.relationship = parsed.meta.relationship || ctx.charNames.map(n => n + ' / ' + ctx.userName).join('、')
        work.tags = parsed.meta.tags.length ? parsed.meta.tags : (work.themeLines || []).map(t => t.replace(/^[^：:]+[：:]/, '')).slice(0, 8)
        work.status = 'ready'
      }
      work.nextDirections = parsed.next || []
      work.words = workWords(work)
      work.failReason = ''
      await persist()
      window.toast?.(isContinue ? `已续写 ${chaps.length} 章` : `已生成「${work.title}」`)
    } catch (e) {
      if (isContinue) work.continuing = false
      else work.status = 'failed'
      work.failReason = String((e && e.message) || '生成失败').slice(0, 120)
      await persist()
      window.toast?.(work.failReason)
    } finally {
      busy = false
      delete progressText[workId]
      refreshReaderIfOpen(workId, isContinue ? (work.chapters.length - 1) : 0)
      refreshList()
    }
  }

  // ===== 页面：主页 =====
  const ui = { tab: 'works', keyword: '', sort: 'date', onlyBookmarks: false, pick: { ownerUid: 0, chars: {}, themes: {} } }

  function symHTML(w) {
    const r = w.ratingId || 'g'
    const warn = w.warning || ''
    const wCls = /无归档/.test(warn) ? 'warn-n' : /不使用/.test(warn) ? 'warn-c' : 'warn-y'
    const wTxt = /无归档/.test(warn) ? '✓' : /不使用/.test(warn) ? '?' : '!'
    const cat = w.category || ''
    const short = /男男/.test(cat) ? 'M/M' : /女女/.test(cat) ? 'F/F' : /男女/.test(cat) ? 'F/M' : /多人/.test(cat) ? 'Multi' : /其他/.test(cat) ? 'Other' : 'Gen'
    return `<p class="ao3-required-tags"><span class="ao3-sym r-${r}" title="${esc(w.rating)}">${r.toUpperCase()}</span><span class="ao3-sym ${wCls}" title="${esc(warn)}">${wTxt}</span><span class="ao3-sym cat">${short}</span></p>`
  }

  function cardHTML(w) {
    const st = w.status || 'ready'
    const badge = st === 'generating' ? '<span class="ao3-badge busy">生成中</span>' : st === 'failed' ? '<span class="ao3-badge fail">生成失败</span>' : ''
    const tags = (w.tags || []).map(t => `<a class="tag">${esc(t)}</a>`).join(', ')
    const sum = w.summary || (st === 'generating' ? '正文与摘要生成中…' : st === 'failed' ? (w.failReason || '生成失败') : '（无摘要）')
    const date = new Date(w.ts).toLocaleDateString()
    return `<div class="ao3-blurb-wrap"><div class="ao3-blurb rating-${w.ratingId || 'g'}" data-id="${w.id}">
      <h4 class="ao3-heading-s"><a>${esc(w.title)}</a>${badge}</h4>
      <div class="ao3-byline">by ${esc(w.author)} · ${esc(date)}</div>
      ${symHTML(w)}
      <div class="ao3-fandom-head">fandom：<a>${esc(w.fandom)}</a></div>
      ${w.relationship ? `<div class="ao3-taglist"><b>relationships：</b><a class="tag">${esc(w.relationship)}</a></div>` : ''}
      ${tags ? `<div class="ao3-taglist"><b>tags：</b>${tags}</div>` : ''}
      <blockquote class="ao3-summary">${esc(sum)}</blockquote>
      <div class="ao3-stats">Words ${workWords(w)} · Chapters ${(w.chapters || []).length} · Kudos ${w.kudos || 0}${store.bookmarks.includes(w.id) ? ' · 已加书签' : ''}</div>
    </div><button type="button" class="ao3-blurb-del" data-del="${w.id}">删除</button></div>`
  }

  function filteredWorks() {
    const kw = ui.keyword.trim().toLowerCase()
    const list = store.works.filter(w => {
      if (ui.onlyBookmarks && !store.bookmarks.includes(w.id)) return false
      if (kw) {
        const hay = [w.title, w.author, w.summary, w.fandom, w.relationship, (w.tags || []).join(' '), (w.characters || []).join(' ')].join(' ').toLowerCase()
        if (hay.indexOf(kw) === -1) return false
      }
      return true
    })
    list.sort((a, b) => ui.sort === 'words' ? workWords(b) - workWords(a) : ui.sort === 'kudos' ? (b.kudos || 0) - (a.kudos || 0) : b.ts - a.ts)
    return list
  }

  function refreshList() {
    const box = document.getElementById('ao3-list')
    if (!box) return
    const list = filteredWorks()
    box.innerHTML = list.length ? list.map(cardHTML).join('') :
      '<div class="ao3-empty"><b>还没有作品</b><p>去「发布」页写一篇吧</p></div>'
    const head = document.getElementById('ao3-count')
    if (head) head.textContent = list.length + ' Works'
  }

  async function showAo3Page() {
    if (document.getElementById('ao3-page')) return
    await load()
    const page = document.createElement('div')
    page.id = 'ao3-page'
    page.className = 'full-page ao3-view'
    page.innerHTML = `
      <div class="ao3-topbar">
        <button class="ao3-back" id="ao3-back" type="button"><i class="fa fa-angle-left"></i></button>
        <div class="ao3-logo"><span class="ao3-logo-mark">AO3</span><span class="ao3-logo-text"><b>同人文站</b><i>An Archive of Our Own</i></span></div>
      </div>
      <div class="ao3-nav" id="ao3-nav">
        <button type="button" data-tab="works" class="active">作品</button>
        <button type="button" data-tab="post">发布</button>
      </div>
      <div class="ao3-main" id="ao3-main"></div>`
    page.querySelector('#ao3-back').addEventListener('click', () => window.closePage('ao3-page'))
    page.querySelector('#ao3-nav').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]')
      if (!b) return
      ui.tab = b.dataset.tab
      renderMain(page)
    })
    window.openPage(page)
    renderMain(page)
  }

  async function renderMain(page) {
    page.querySelectorAll('#ao3-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab))
    const main = page.querySelector('#ao3-main')
    if (ui.tab === 'works') renderWorksTab(main)
    else await renderPostTab(main, page)
  }

  function renderWorksTab(main) {
    main.innerHTML = `
      <div class="ao3-filter">
        <input id="ao3-search" type="search" placeholder="搜索标题、标签、角色…" value="${esc(ui.keyword)}">
        <div class="ao3-fandoms">
          <button type="button" class="ao3-chip${ui.sort === 'date' ? ' on' : ''}" data-sort="date">最新</button>
          <button type="button" class="ao3-chip${ui.sort === 'words' ? ' on' : ''}" data-sort="words">字数</button>
          <button type="button" class="ao3-chip${ui.sort === 'kudos' ? ' on' : ''}" data-sort="kudos">点赞</button>
          <button type="button" class="ao3-chip${ui.onlyBookmarks ? ' on' : ''}" data-bm="1">只看书签</button>
        </div>
      </div>
      <h2 class="ao3-heading"><span id="ao3-count"></span></h2>
      <div id="ao3-list"></div>`
    main.querySelector('#ao3-search').addEventListener('input', e => { ui.keyword = e.target.value; refreshList() })
    main.querySelector('.ao3-fandoms').addEventListener('click', e => {
      const b = e.target.closest('button')
      if (!b) return
      if (b.dataset.sort) ui.sort = b.dataset.sort
      if (b.dataset.bm) ui.onlyBookmarks = !ui.onlyBookmarks
      renderWorksTab(main)
    })
    main.querySelector('#ao3-list').addEventListener('click', async e => {
      const del = e.target.closest('[data-del]')
      if (del) {
        e.stopPropagation()
        const id = Number(del.dataset.del)
        const w = getWork(id)
        if (!w) return
        if (!window.confirm('删除「' + w.title + '」？删除后无法恢复。')) return
        store.works = store.works.filter(x => x.id !== id)
        store.bookmarks = store.bookmarks.filter(x => x !== id)
        store.kudos = store.kudos.filter(x => x !== id)
        await persist()
        refreshList()
        return
      }
      const card = e.target.closest('.ao3-blurb')
      if (card) openReader(Number(card.dataset.id))
    })
    refreshList()
  }

  // ===== 发布页 =====
  async function loadFriends(ownerUid) {
    const cfg = await db.config.get(`friends_${ownerUid}`)
    const ids = Array.isArray(cfg?.value) ? cfg.value : []
    const rows = []
    for (const id of ids) {
      const c = await db.characters.get(parseInt(id, 10))
      if (c && c.type !== 'user') rows.push(c)
    }
    return rows
  }

  async function renderPostTab(main, page) {
    const users = (await db.characters.where('type').equals('user').toArray()).sort((a, b) => (b.id || 0) - (a.id || 0))
    if (!users.length) {
      main.innerHTML = '<div class="ao3-empty"><b>还没有微信账号</b><p>请先在微信里登录或创建 USER 角色</p></div>'
      return
    }
    if (!users.some(u => u.id === ui.pick.ownerUid)) { ui.pick.ownerUid = users[0].id; ui.pick.chars = {} }
    const friends = await loadFriends(ui.pick.ownerUid)
    const themeHTML = THEME_GROUPS.map(g => {
      const cur = ui.pick.themes[g.id] || ''
      return `<div class="ao3-theme-group"><b>${esc(g.name)}</b><div class="ao3-theme-opts">` +
        `<button type="button" class="ao3-chip${!cur ? ' on' : ''}" data-tg="${g.id}" data-tv="">不限</button>` +
        g.options.map(o => `<button type="button" class="ao3-chip${cur === o ? ' on' : ''}" data-tg="${g.id}" data-tv="${esc(o)}">${esc(o)}</button>`).join('') +
        `</div></div>`
    }).join('')
    main.innerHTML = `
      <div class="ao3-form-card">
        <h2>发布新作品</h2>
        <div class="ao3-notice">每次发布会调用一次 AI，一次性写完标题、摘要、全部章节和 3 个续写方向。章数越多越慢，建议先写 1 章。</div>
        ${users.length > 1 ? `<div class="ao3-field"><label>人设（微信账号）</label><select id="ao3-user" class="ao3-select">${users.map(u => `<option value="${u.id}"${u.id === ui.pick.ownerUid ? ' selected' : ''}>${esc(u.nick || u.name || '我')}</option>`).join('')}</select></div>` : ''}
        <div class="ao3-field"><label>选择角色（可多选）</label>
          <div class="ao3-char-list" id="ao3-chars">${friends.length ? friends.map(f => `<label class="ao3-char-item"><input type="checkbox" data-cid="${f.id}"${ui.pick.chars[f.id] ? ' checked' : ''}><span><b>${esc(charName(f))}</b></span></label>`).join('') : '<div class="ao3-char-empty">这个账号还没有好友</div>'}</div></div>
        <div class="ao3-field-row">
          <div class="ao3-field"><label>领域</label><select id="ao3-fandom" class="ao3-select">${FANDOMS.map(f => `<option>${f}</option>`).join('')}</select></div>
          <div class="ao3-field"><label>分类</label><select id="ao3-cat" class="ao3-select">${CATS.map(f => `<option>${f}</option>`).join('')}</select></div>
        </div>
        <div class="ao3-field-row">
          <div class="ao3-field"><label>评级</label><select id="ao3-rating" class="ao3-select">${RATINGS.map(r => `<option value="${r.id}">${r.name}</option>`).join('')}</select></div>
          <div class="ao3-field"><label>归档警告</label><select id="ao3-warning" class="ao3-select">${WARNINGS.map(f => `<option>${f}</option>`).join('')}</select></div>
        </div>
        <div class="ao3-field-row">
          <div class="ao3-field"><label>章数</label><select id="ao3-chapters" class="ao3-select">${CHAPTER_COUNTS.map(n => `<option value="${n}">${n} 章</option>`).join('')}</select></div>
          <div class="ao3-field"><label>每章字数</label><select id="ao3-words" class="ao3-select">${WORDS.map(n => `<option value="${n}"${n === 1500 ? ' selected' : ''}>约 ${n} 字</option>`).join('')}</select></div>
        </div>
        <div class="ao3-field"><label>主题（每类最多选一个）</label><div id="ao3-themes">${themeHTML}</div></div>
        <div class="ao3-field"><label>创作备注 <em>可选</em></label><textarea id="ao3-prompt" class="ao3-textarea" placeholder="想写什么情节、什么场景、什么感觉都可以说"></textarea></div>
        <button type="button" class="ao3-submit" id="ao3-publish">发布作品</button>
      </div>`
    const q = id => main.querySelector(id)
    q('#ao3-user')?.addEventListener('change', e => { ui.pick.ownerUid = Number(e.target.value); ui.pick.chars = {}; renderPostTab(main, page) })
    q('#ao3-chars').addEventListener('change', e => {
      const inp = e.target.closest('input[data-cid]')
      if (inp) ui.pick.chars[inp.dataset.cid] = !!inp.checked
    })
    q('#ao3-themes').addEventListener('click', e => {
      const b = e.target.closest('[data-tg]')
      if (!b) return
      if (b.dataset.tv) ui.pick.themes[b.dataset.tg] = b.dataset.tv
      else delete ui.pick.themes[b.dataset.tg]
      const keep = main.querySelector('#ao3-prompt').value
      q('#ao3-themes').innerHTML = THEME_GROUPS.map(g => {
        const cur = ui.pick.themes[g.id] || ''
        return `<div class="ao3-theme-group"><b>${esc(g.name)}</b><div class="ao3-theme-opts">` +
          `<button type="button" class="ao3-chip${!cur ? ' on' : ''}" data-tg="${g.id}" data-tv="">不限</button>` +
          g.options.map(o => `<button type="button" class="ao3-chip${cur === o ? ' on' : ''}" data-tg="${g.id}" data-tv="${esc(o)}">${esc(o)}</button>`).join('') +
          `</div></div>`
      }).join('')
      main.querySelector('#ao3-prompt').value = keep
    })
    q('#ao3-publish').addEventListener('click', () => publish(main, page, users))
  }

  async function publish(main, page, users) {
    if (busy) { window.toast?.('正在生成，请稍候'); return }
    const charIds = Object.keys(ui.pick.chars).filter(k => ui.pick.chars[k]).map(Number)
    if (!charIds.length) { window.toast?.('请至少选择一个角色'); return }
    if (typeof window.callAI !== 'function') { window.toast?.('请先在设置里配置 API'); return }
    const user = users.find(u => u.id === ui.pick.ownerUid)
    const names = []
    for (const id of charIds) { const c = await db.characters.get(id); if (c) names.push(charName(c)) }
    const ratingId = main.querySelector('#ao3-rating').value
    const themeLines = THEME_GROUPS.filter(g => ui.pick.themes[g.id]).map(g => g.name + '：' + ui.pick.themes[g.id])
    const work = {
      id: store.seq++,
      title: '生成中…',
      author: (user && (user.nick || user.name)) || '我',
      ownerUid: ui.pick.ownerUid,
      charIds,
      fandom: main.querySelector('#ao3-fandom').value,
      category: main.querySelector('#ao3-cat').value,
      ratingId,
      rating: ratingName(ratingId),
      warning: main.querySelector('#ao3-warning').value,
      chapterCount: Number(main.querySelector('#ao3-chapters').value) || 1,
      wordsPerChapter: Number(main.querySelector('#ao3-words').value) || 1500,
      themeLines,
      prompt: (main.querySelector('#ao3-prompt').value || '').trim().slice(0, 500),
      characters: [(user && (user.nick || user.name)) || '我'].concat(names),
      tags: [], relationship: '', summary: '', chapters: [], nextDirections: [],
      status: 'generating', continuing: false, failReason: '', kudos: 0, ts: Date.now()
    }
    store.works.unshift(work)
    await persist()
    ui.tab = 'works'
    ui.pick.chars = {}
    ui.pick.themes = {}
    renderMain(page)
    window.toast?.('已提交，正在生成…')
    generate(work.id, 'new')
  }

  // ===== 阅读页 =====
  let readState = { id: null, ci: 0 }

  function openReader(id) {
    if (document.getElementById('ao3-read-page')) return
    const w = getWork(id)
    if (!w) return
    readState = { id, ci: 0 }
    if (w.status === 'ready') { w.hits = (w.hits || 0) + 1; persist() }
    const page = document.createElement('div')
    page.id = 'ao3-read-page'
    page.className = 'full-page ao3-read-view'
    page.innerHTML = `
      <div class="ao3-topbar">
        <button class="ao3-back" id="ao3-read-back" type="button"><i class="fa fa-angle-left"></i></button>
        <h1 class="ao3-read-title" id="ao3-read-title"></h1>
      </div>
      <div class="ao3-read-main" id="ao3-read-main"></div>
      <div class="ao3-read-actions" id="ao3-read-actions"></div>`
    page.querySelector('#ao3-read-back').addEventListener('click', () => { window.closePage('ao3-read-page'); refreshList() })
    window.openPage(page)
    renderReader()
  }

  function refreshReaderIfOpen(id, ci) {
    if (!document.getElementById('ao3-read-page') || readState.id !== id) return
    if (typeof ci === 'number') readState.ci = Math.max(0, ci)
    renderReader()
  }

  function renderReader() {
    const w = getWork(readState.id)
    const page = document.getElementById('ao3-read-page')
    if (!w || !page) return
    const st = w.status || 'ready'
    page.querySelector('#ao3-read-title').textContent = w.title
    const chaps = w.chapters || []
    if (readState.ci >= chaps.length) readState.ci = 0
    const cur = chaps[readState.ci]
    const tagList = (w.tags || []).map(t => `<a class="tag">${esc(t)}</a>`).join(', ')
    const metaRows = [
      ['Rating', w.rating], ['Archive Warning', w.warning], ['Category', w.category], ['Fandom', w.fandom],
      ['Relationship', w.relationship], ['Characters', (w.characters || []).join('、')]
    ].filter(r => r[1]).map(r => `<div class="meta-row"><dt>${r[0]}:</dt><dd>${esc(r[1])}</dd></div>`).join('') +
      (tagList ? `<div class="meta-row"><dt>Additional Tags:</dt><dd>${tagList}</dd></div>` : '') +
      ((w.themeLines || []).length ? `<div class="meta-row"><dt>Themes:</dt><dd>${esc(w.themeLines.join('、'))}</dd></div>` : '') +
      `<div class="meta-row"><dt>Stats:</dt><dd>${workWords(w)} words · ${chaps.length} chapters · ${w.kudos || 0} kudos · ${w.hits || 0} hits</dd></div>`
    let body = ''
    if (st === 'generating') {
      body = `<div class="ao3-generating"><div class="ao3-spinner"></div><b>正文生成中</b><p>${esc(progressText[w.id] || '请稍候…')}</p></div>`
    } else if (st === 'failed') {
      body = `<div class="ao3-generating"><b>生成失败</b><p>${esc(w.failReason || '请重试')}</p><button type="button" class="ao3-submit" id="ao3-retry" style="max-width:200px;margin-top:12px">重新生成</button></div>`
    } else {
      const nav = chaps.length > 1
        ? `<div class="ao3-chap-nav">${chaps.map((c, i) => `<button type="button" class="${i === readState.ci ? 'on' : ''}" data-ci="${i}">${esc(c.title.replace(/ · .*/, ''))}</button>`).join('')}</div>` : ''
      const banner = w.continuing ? `<div class="ao3-cont-banner"><div class="ao3-spinner small"></div><span>${esc(progressText[w.id] || '续写中…')}</span></div>` : ''
      const dirs = (!w.continuing && readState.ci === chaps.length - 1 && (w.nextDirections || []).length)
        ? `<div class="ao3-dir-hint"><b>后续可走的方向</b>${w.nextDirections.map((d, i) => `<span>方向${i + 1}：${esc(d)}</span>`).join('')}<em>点底栏「继续」选择方向并追加章节</em></div>` : ''
      body = nav + banner + `<div class="ao3-chapter"><h3>${esc(cur ? cur.title : '')}</h3><div class="ao3-chapter-body">${cur ? bodyHTML(cur.body) : ''}</div>${dirs}</div>`
    }
    page.querySelector('#ao3-read-main').innerHTML =
      `<div class="ao3-preface"><h2 class="title">${esc(w.title)}</h2><div class="byline">by ${esc(w.author)}</div>${symHTML(w)}<dl class="ao3-meta-dl">${metaRows}</dl>${w.summary ? `<blockquote class="ao3-summary"><b>Summary:</b> ${esc(w.summary)}</blockquote>` : ''}</div>` + body
    const canAct = st === 'ready' && !w.continuing
    const liked = store.kudos.includes(w.id)
    const marked = store.bookmarks.includes(w.id)
    page.querySelector('#ao3-read-actions').innerHTML =
      `<button type="button" data-act="kudos" class="${liked ? 'on' : ''}"${canAct ? '' : ' disabled'}>${liked ? '已点赞' : '点赞'}</button>` +
      `<button type="button" data-act="bm" class="${marked ? 'on' : ''}"${canAct ? '' : ' disabled'}>${marked ? '已加书签' : '加书签'}</button>` +
      `<button type="button" data-act="cont"${canAct ? '' : ' disabled'}>${w.continuing ? '续写中…' : '继续'}</button>` +
      `<button type="button" data-act="del" class="danger"${w.continuing ? ' disabled' : ''}>删除</button>`
    const main = page.querySelector('#ao3-read-main')
    main.querySelector('.ao3-chap-nav')?.addEventListener('click', e => {
      const b = e.target.closest('[data-ci]')
      if (!b) return
      readState.ci = Number(b.dataset.ci) || 0
      renderReader()
      main.scrollTop = 0
    })
    main.querySelector('#ao3-retry')?.addEventListener('click', () => generate(w.id, 'new'))
    page.querySelector('#ao3-read-actions').onclick = async e => {
      const b = e.target.closest('[data-act]')
      if (!b || b.disabled) return
      const act = b.dataset.act
      if (act === 'kudos') {
        const i = store.kudos.indexOf(w.id)
        if (i > -1) { store.kudos.splice(i, 1); w.kudos = Math.max(0, (w.kudos || 0) - 1) } else { store.kudos.push(w.id); w.kudos = (w.kudos || 0) + 1 }
        await persist(); renderReader()
      } else if (act === 'bm') {
        const i = store.bookmarks.indexOf(w.id)
        if (i > -1) store.bookmarks.splice(i, 1); else store.bookmarks.push(w.id)
        await persist(); renderReader()
      } else if (act === 'cont') {
        openContinuePad(w)
      } else if (act === 'del') {
        if (!window.confirm('删除「' + w.title + '」？删除后无法恢复。')) return
        store.works = store.works.filter(x => x.id !== w.id)
        store.bookmarks = store.bookmarks.filter(x => x !== w.id)
        store.kudos = store.kudos.filter(x => x !== w.id)
        await persist()
        window.closePage('ao3-read-page')
        refreshList()
      }
    }
  }

  // ===== 续写弹窗 =====
  function openContinuePad(w) {
    if (busy) { window.toast?.('正在生成，请稍候'); return }
    const page = document.getElementById('ao3-read-page')
    if (!page || page.querySelector('.ao3-continue-backdrop')) return
    const dirs = (w.nextDirections || []).filter(Boolean)
    const bd = document.createElement('div')
    bd.className = 'ao3-continue-backdrop show'
    bd.innerHTML = `
      <div class="ao3-continue-card">
        <h2>继续写下去</h2>
        <p class="ao3-continue-tip">选一个方向，或者自己写。会调用一次 AI，在现有章节后面追加。</p>
        <div class="ao3-continue-dirs" id="ao3-dirs">${dirs.length ? dirs.map((d, i) => `<button type="button" class="ao3-dir-tag" data-dir="${esc(d)}"><b>方向 ${i + 1}</b><span>${esc(d)}</span></button>`).join('') : '<p class="ao3-dir-empty">还没有推荐方向，可以在下面自己填写。</p>'}</div>
        <label class="ao3-continue-label">续写主旨</label>
        <textarea id="ao3-dir-input" class="ao3-textarea" placeholder="选择上面的方向，或自己写一句话"></textarea>
        <label class="ao3-continue-label">追加章数</label>
        <select id="ao3-dir-chap" class="ao3-select">${CHAPTER_COUNTS.map(n => `<option value="${n}">${n} 章</option>`).join('')}</select>
        <div class="ao3-continue-btns"><button type="button" class="ao3-btn-ghost" id="ao3-dir-cancel">取消</button><button type="button" class="ao3-submit ao3-continue-go" id="ao3-dir-go">开始续写</button></div>
      </div>`
    page.appendChild(bd)
    const input = bd.querySelector('#ao3-dir-input')
    bd.addEventListener('click', e => { if (e.target === bd) bd.remove() })
    bd.querySelector('#ao3-dir-cancel').addEventListener('click', () => bd.remove())
    bd.querySelector('#ao3-dirs').addEventListener('click', e => {
      const b = e.target.closest('.ao3-dir-tag')
      if (!b) return
      const on = b.classList.contains('on')
      bd.querySelectorAll('.ao3-dir-tag').forEach(x => x.classList.remove('on'))
      if (on) { input.value = ''; return }
      b.classList.add('on')
      input.value = b.dataset.dir || ''
    })
    bd.querySelector('#ao3-dir-go').addEventListener('click', () => {
      const dir = input.value.trim()
      if (!dir) { window.toast?.('请选择或填写一个续写方向'); return }
      const n = Number(bd.querySelector('#ao3-dir-chap').value) || 1
      bd.remove()
      generate(w.id, 'continue', { direction: dir.slice(0, 120), chapN: n })
    })
  }

  window.showAo3Page = showAo3Page
})()
