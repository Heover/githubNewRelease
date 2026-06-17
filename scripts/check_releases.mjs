/**
 * GitHub Star 仓库 新 Release 监控 + 手机通知工具
 * 通过 GitHub Action 每日定时执行，只通知上次检查后新增的 Release。
 * 使用 MongoDB 存储上次检查时间（不产生额外 git 提交）。
 *
 * 通知方式：Server 酱3（手机 App）
 *
 * 需要设置以下环境变量：
 *   - MONITOR_USER: 要监控的 GitHub 用户名
 *   - MONGODB_URI: MongoDB 连接字符串
 *   - GITHUB_TOKEN: GitHub Personal Access Token（可选，提高 API 速率限制）
 *   - SERVER_UID: Server 酱3 用户 UID（从 https://sc3.ft07.com/sendkey 获取）
 *   - SERVER_KEY: Server 酱3 SendKey（从 https://sc3.ft07.com/sendkey 获取）
 *
 * 要求 Node.js >= 18（原生 fetch 支持）
 */

import { MongoClient } from "mongodb";

// ============================================================
// 配置
// ============================================================

const MONITOR_USER = process.env.MONITOR_USER || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const MONGODB_URI = process.env.MONGODB_URI || "";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_STARRED_URL = `${GITHUB_API_BASE}/users/${MONITOR_USER}/starred`;

/** 首次运行回退窗口（小时），仅在 MongoDB 无记录时使用 */
const FALLBACK_WINDOW_HOURS = 48;
const PER_PAGE = 100;

const DB_NAME = "release_monitor";
const COLL_NAME = "check_state";
const DOC_KEY = "last_check";

// ============================================================
// MongoDB 上次检查时间
// ============================================================

let mongoClient = null;

async function getMongoCollection() {
  if (!MONGODB_URI) {
    throw new Error("未设置 MONGODB_URI 环境变量");
  }
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
  }
  return mongoClient.db(DB_NAME).collection(COLL_NAME);
}

/** 从 MongoDB 读取上次检查时间，若无记录则回退到 48h 前 */
async function getLastCheckTime() {
  try {
    const coll = await getMongoCollection();
    const doc = await coll.findOne({ _id: DOC_KEY });
    if (doc?.time) {
      const time = new Date(doc.time);
      if (!isNaN(time.getTime())) {
        console.log(`  📅 上次检查(DB): ${beijingTimeStr(time)}`);
        return time;
      }
    }
  } catch (e) {
    console.log(`  ⚠️  MongoDB 读取失败: ${e.message}`);
  }
  const fallback = new Date(Date.now() - FALLBACK_WINDOW_HOURS * 60 * 60 * 1000);
  console.log(`  🆕 首次运行，回退至 ${FALLBACK_WINDOW_HOURS}h 前: ${beijingTimeStr(fallback)}`);
  return fallback;
}

/** 保存当前 UTC 时间到 MongoDB */
async function saveLastCheckTime() {
  try {
    const coll = await getMongoCollection();
    await coll.updateOne(
      { _id: DOC_KEY },
      { $set: { time: new Date().toISOString(), user: MONITOR_USER, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log("  💾 检查时间已保存到 MongoDB");
  } catch (e) {
    console.log(`  ⚠️  MongoDB 保存失败: ${e.message}`);
  }
}

/** 构建 GitHub API 请求头 */
function getGitHubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "GitHub-Release-Monitor/1.0",
  };
  if (GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

/** 获取北京时间格式化字符串 */
function beijingTimeStr(date = new Date()) {
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

/** 将 ISO 时间转为北京时间 YYYY-MM-DD HH:mm:ss */
function beijingTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const s = d.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false });
  return s.replace("T", " ");
}

/** 安全 fetch 封装 */
async function safeFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// GitHub API
// ============================================================

/** 获取指定用户 star 的所有仓库 */
async function fetchStarredRepos() {
  if (!MONITOR_USER) {
    console.log("  ❌ 未设置 MONITOR_USER 环境变量");
    return [];
  }

  const repos = [];
  let page = 1;

  while (true) {
    const url = `${GITHUB_STARRED_URL}?per_page=${PER_PAGE}&page=${page}`;
    let resp;
    try {
      resp = await safeFetch(url, { headers: getGitHubHeaders(), timeout: 30000 });
    } catch {
      console.log("  ❌ 获取 star 列表超时");
      break;
    }

    if (resp.status === 403) {
      console.log(`  ⚠️  API 速率限制: ${resp.headers.get("X-RateLimit-Remaining") || "?"} 次剩余`);
      break;
    }
    if (resp.status === 404) {
      console.log(`  ❌ 用户 ${MONITOR_USER} 不存在`);
      break;
    }
    if (!resp.ok) {
      console.log(`  ❌ 网络请求失败: HTTP ${resp.status}`);
      break;
    }

    let data;
    try {
      data = await resp.json();
    } catch {
      console.log("  ❌ 响应解析失败");
      break;
    }
    if (!data || data.length === 0) break;

    repos.push(...data);
    page++;
    if (data.length < PER_PAGE) break;
  }

  console.log(`  📦 共获取到 ${repos.length} 个 star 仓库`);
  return repos;
}

/** 获取仓库最近的 releases，筛选在 cutoff 之后的 */
async function fetchRecentReleases(owner, repo, cutoff) {
  const releasesUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases`;
  const recent = [];
  let page = 1;

  while (true) {
    let resp;
    try {
      resp = await safeFetch(`${releasesUrl}?per_page=5&page=${page}`, {
        headers: getGitHubHeaders(),
        timeout: 15000,
      });
    } catch {
      break;
    }
    if (!resp.ok) break;

    let data;
    try {
      data = await resp.json();
    } catch {
      break;
    }
    if (!data || data.length === 0) break;

    let allOld = true;
    for (const release of data) {
      const published = new Date(release.published_at);
      if (published >= cutoff) {
        recent.push(release);
        allOld = false;
      }
    }
    if (allOld || data.length < 5) break;
    page++;
  }

  return recent;
}

/** 检查单个仓库的 Release 并收集结果 */
async function checkRepoReleases(owner, name, fullName, repoUrl, cutoff, allNewReleases, idx, total) {
  process.stdout.write(`  [${idx}/${total}] 检查 ${fullName}... `);

  const recent = await fetchRecentReleases(owner, name, cutoff);

  if (recent.length > 0) {
    console.log(`✨ ${recent.length} 个新 Release`);
    for (const rel of recent) {
      allNewReleases.push({
        repo: fullName,
        repoUrl: repoUrl || `https://github.com/${owner}/${name}`,
        tag: rel.tag_name || "",
        name: rel.name || rel.tag_name || "",
        url: rel.html_url || "",
        publishedAt: rel.published_at || "",
        body: (rel.body || "").slice(0, 200),
      });
    }
  } else {
    console.log("—");
  }
}

/** 检查所有 star 仓库在 cutoff 之后的 release */
async function checkAllStarredReleases(cutoff) {

  const repos = await fetchStarredRepos();
  if (!repos || repos.length === 0) {
    return { error: "无法获取 star 仓库列表", newReleases: [] };
  }

  const allNewReleases = [];
  const total = repos.length;

  for (let idx = 0; idx < repos.length; idx++) {
    const repo = repos[idx];
    const fullName = repo.full_name || "unknown";
    const owner = repo.owner?.login || "";
    const name = repo.name || "";

    if (!owner || !name) continue;

    await checkRepoReleases(owner, name, fullName, repo.html_url || "", cutoff, allNewReleases, idx + 1, total);
  }

  // push 触发时若无新增，取所有 star 仓库中最新的一条 release 作为测试展示
  const isPush = process.env.GITHUB_EVENT_NAME === "push";
  let testLatest = null;
  if (isPush && allNewReleases.length === 0) {
    console.log("\n  🧪 push 触发且无新增，查找 star 仓库中最新的 release...");
    let newestTime = new Date(0);
    let newestRel = null;
    for (let idx = 0; idx < repos.length; idx++) {
      const repo = repos[idx];
      const owner = repo.owner?.login || "";
      const name = repo.name || "";
      if (!owner || !name) continue;
      const recent = await fetchRecentReleases(owner, name, new Date(0));
      if (recent.length > 0) {
        const t = new Date(recent[0].published_at);
        if (t > newestTime) {
          newestTime = t;
          newestRel = {
            repo: repo.full_name,
            repoUrl: repo.html_url || "",
            tag: recent[0].tag_name || "",
            name: recent[0].name || recent[0].tag_name || "",
            url: recent[0].html_url || "",
            publishedAt: recent[0].published_at || "",
            body: (recent[0].body || "").slice(0, 200),
          };
        }
      }
    }
    if (newestRel) {
      testLatest = newestRel;
      allNewReleases.push(newestRel);
    }
  }

  return {
    success: true,
    newReleases: allNewReleases,
    totalStarred: total,
    checkedAt: beijingTimeStr(),
    isPushTest: isPush && !!testLatest,
  };
}

// ============================================================
// 格式化消息
// ============================================================

function formatReleaseMessage(result) {
  if (result.error) {
    return (
      `⚠️ GitHub Release 监控异常\n\n` +
      `用户: ${MONITOR_USER}\n\n` +
      `原因: ${result.error}`
    );
  }

  const newReleases = result.newReleases || [];
  const totalStarred = result.totalStarred || 0;
  const checkedAt = result.checkedAt || "";
  const isPushTest = result.isPushTest || false;

  if (newReleases.length === 0) {
    return (
      `📭 用户 ${MONITOR_USER} star 的 ${totalStarred} 个仓库无新增 Release\n\n` +
      `⏰ ${checkedAt}`
    );
  }

  // 正文：具体 Release 在前，用双换行分隔
  const items = [];
  newReleases.forEach((rel, i) => {
    items.push(
      `${i + 1}. ${rel.repo}\n` +
        `   🏷️ ${rel.tag} — ${rel.name}\n` +
        `   🔗 ${rel.url}\n` +
        `   🕐 ${beijingTime(rel.publishedAt)}`
    );
  });

  // 末尾补充摘要
  const tag = isPushTest ? "🧪 测试模式 — star 仓库最新 Release" : `上次检查后新增 ${newReleases.length} 个 Release`;
  items.push(`\n📊 ${tag} | ${MONITOR_USER} | 监控 ${totalStarred} 个仓库 | ${checkedAt}`);

  return items.join("\n\n");
}

// ============================================================
// Server 酱3 通知
// ============================================================

async function sendServerchanMessage(title, message) {
  const uid = process.env.SERVER_UID || "";
  const sendkey = process.env.SERVER_KEY || "";
  if (!uid || !sendkey) {
    return { error: "未设置 SERVER_UID 或 SERVER_KEY" };
  }

  const url = `https://${uid}.push.ft07.com/send/${sendkey}.send`;
  console.log(`  📤 请求URL: ${url}`);
  console.log(`  📝 标题: ${title}`);
  console.log(`  📄 内容预览:\n${message.slice(0, 500)}...`);

  try {
    const resp = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title, desp: message }),
      timeout: 15000,
    });

    console.log(`  📡 HTTP状态: ${resp.status}`);

    if (!resp.ok) {
      const body = await resp.text();
      console.log(`  ❌ 响应体: ${body}`);
      return { error: `Server酱3 HTTP ${resp.status}` };
    }

    const result = await resp.json();
    console.log(`  📥 响应: ${JSON.stringify(result)}`);

    if (result.code === 0) {
      return { success: true, data: result };
    } else {
      return { error: result.message || "Server酱3 返回失败" };
    }
  } catch (e) {
    if (e.name === "AbortError") {
      return { error: "Server酱3 请求超时" };
    }
    return { error: `Server酱3 请求失败: ${e.message}` };
  }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log("=".repeat(55));
  console.log("GitHub Star 仓库 Release 监控");
  console.log("=".repeat(55));

  if (!MONITOR_USER) {
    console.log("\n❌ 未设置 MONITOR_USER，请在 GitHub Variables 中配置");
    process.exit(1);
  }

  console.log(`\n👤 监控用户: ${MONITOR_USER}`);
  if (GITHUB_TOKEN) {
    console.log("🔑 已配置 GitHub Token");
  } else {
    console.log("⚠️  未配置 GitHub Token（API 速率限制较低）");
  }

  // 读取上次检查时间
  const cutoff = await getLastCheckTime();

  // 1. 检查 Release
  console.log("\n[1/3] 正在扫描上次检查后新增的 Release...");
  const checkResult = await checkAllStarredReleases(cutoff);

  // 保存本次时间
  await saveLastCheckTime();

  // 2. 格式化消息
  console.log("\n[2/3] 正在格式化消息...");
  const message = formatReleaseMessage(checkResult);

  const newCount = (checkResult.newReleases || []).length;
  console.log(`  共发现 ${newCount} 个新 Release`);

  // 3. 发送通知
  console.log("\n[3/3] 正在发送通知...");

  let sent = false;

  console.log("  → 通过 Server 酱发送...");
  const scResult = await sendServerchanMessage("GitHub Release 监控", message);
  if (!scResult.error) {
    console.log("  ✅ Server 酱发送成功");
    sent = true;
  } else {
    console.log(`  ❌ Server 酱发送失败: ${scResult.error}`);
  }

  if (!sent) {
    console.log("\n⚠️  通知发送失败");
  }

  // 最终状态
  if (checkResult.error) {
    console.log("\n⚠️  任务完成（检查过程异常）");
    process.exit(1);
  } else {
    console.log(`\n✅ 任务完成 - 扫描 ${checkResult.totalStarred} 个仓库，${newCount} 个新 Release`);
    process.exit(0);
  }
}

main();
