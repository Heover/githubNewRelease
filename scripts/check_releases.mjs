/**
 * GitHub Star 仓库 新 Release 监控 + 手机通知工具
 * 通过 GitHub Action 每日定时执行，只通知上次检查后新增的 Release。
 *
 * 通知方式：Server 酱3（手机 App）
 *
 * 需要设置以下环境变量：
 *   - MONITOR_USER: 要监控的 GitHub 用户名
 *   - GITHUB_TOKEN: GitHub Personal Access Token（可选，提高 API 速率限制）
 *   - SERVER_UID: Server 酱3 用户 UID（从 https://sc3.ft07.com/sendkey 获取）
 *   - SERVER_KEY: Server 酱3 SendKey（从 https://sc3.ft07.com/sendkey 获取）
 *
 * 要求 Node.js >= 18（原生 fetch 支持）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ============================================================
// 配置
// ============================================================

const MONITOR_USER = process.env.MONITOR_USER || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_STARRED_URL = `${GITHUB_API_BASE}/users/${MONITOR_USER}/starred`;

/** 首次运行回退窗口（小时），仅在无 last_check.txt 时使用 */
const FALLBACK_WINDOW_HOURS = 48;
const PER_PAGE = 100;

/** 记录上次检查时间的文件 */
const LAST_CHECK_FILE = "last_check.txt";

// ============================================================
// 上次检查时间
// ============================================================

/** 读取上次检查时间（UTC ISO 字符串），若不存在则回退到 48h 前 */
function getLastCheckTime() {
  if (existsSync(LAST_CHECK_FILE)) {
    const content = readFileSync(LAST_CHECK_FILE, "utf-8").trim();
    if (content) {
      const time = new Date(content);
      if (!isNaN(time.getTime())) {
        console.log(`  📅 上次检查: ${beijingTimeStr(time)}`);
        return time;
      }
    }
  }
  const fallback = new Date(Date.now() - FALLBACK_WINDOW_HOURS * 60 * 60 * 1000);
  console.log(`  🆕 首次运行，回退至 ${FALLBACK_WINDOW_HOURS}h 前: ${beijingTimeStr(fallback)}`);
  return fallback;
}

/** 保存当前 UTC 时间作为下次检查基准 */
function saveLastCheckTime() {
  writeFileSync(LAST_CHECK_FILE, new Date().toISOString(), "utf-8");
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

    process.stdout.write(`  [${idx + 1}/${total}] 检查 ${fullName}... `);

    const recent = await fetchRecentReleases(owner, name, cutoff);

    if (recent.length > 0) {
      console.log(`✨ ${recent.length} 个新 Release`);
      for (const rel of recent) {
        allNewReleases.push({
          repo: fullName,
          repoUrl: repo.html_url || "",
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

  return {
    success: true,
    newReleases: allNewReleases,
    totalStarred: total,
    checkedAt: beijingTimeStr(),
  };
}

// ============================================================
// 格式化消息
// ============================================================

function formatReleaseMessage(result) {
  if (result.error) {
    return (
      `⚠️ GitHub Release 监控异常\n` +
      `用户: ${MONITOR_USER}\n` +
      `原因: ${result.error}`
    );
  }

  const newReleases = result.newReleases || [];
  const totalStarred = result.totalStarred || 0;
  const checkedAt = result.checkedAt || "";

  if (newReleases.length === 0) {
    return (
      `📭 用户 ${MONITOR_USER} star 的 ${totalStarred} 个仓库无新增 Release\n` +
      `⏰ ${checkedAt}`
    );
  }

  // 正文：具体 Release 在前
  const lines = [];
  newReleases.forEach((rel, i) => {
    lines.push(
      `${i + 1}. ${rel.repo}\n` +
        `   🏷️ ${rel.tag} — ${rel.name}\n` +
        `   🔗 ${rel.url}\n` +
        `   🕐 ${beijingTime(rel.publishedAt)}\n`
    );
  });

  // 末尾补充摘要
  lines.push(`📊 上次检查后新增 ${newReleases.length} 个 Release | ${MONITOR_USER} | 监控 ${totalStarred} 个仓库 | ${checkedAt}`);

  return lines.join("\n");
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

  try {
    const resp = await safeFetch(`https://${uid}.push.ft07.com/send/${sendkey}.send`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title, desp: message }),
      timeout: 15000,
    });

    if (!resp.ok) {
      return { error: `Server酱3 HTTP ${resp.status}` };
    }

    const result = await resp.json();

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
  const cutoff = getLastCheckTime();

  // 1. 检查 Release
  console.log("\n[1/3] 正在扫描上次检查后新增的 Release...");
  const checkResult = await checkAllStarredReleases(cutoff);

  // 保存本次时间
  saveLastCheckTime();

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
