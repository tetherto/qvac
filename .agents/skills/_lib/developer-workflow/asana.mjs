import { execFileSync } from "node:child_process";

import { loadConfig } from "./config.mjs";

const ASANA_API = "https://app.asana.com/api/1.0";

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function tokenFromDefaultShell(envName) {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      const comspec = process.env.ComSpec || "cmd.exe";
      const cmdToken = execFileSync(comspec, ["/d", "/s", "/c", `echo %${envName}%`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (cmdToken && cmdToken !== `%${envName}%`) return cmdToken;

      const psToken = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable(${powerShellQuote(envName)}, 'User')`],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return psToken || null;
    }

    const shell = process.env.SHELL || "/bin/sh";
    const command = `printf %s "$${envName}"`;
    const token = execFileSync(shell, ["-l", "-c", command], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function getAsanaToken(config = loadConfig()) {
  const envName = config.asana?.tokenEnv || "ASANA_ACCESS_TOKEN";
  let token = process.env[envName];
  if (!token && config.asana?.tokenShellFallback !== false) {
    token = tokenFromDefaultShell(envName);
  }
  if (!token) {
    throw new Error(
      `Asana token missing. Set ${envName} in your shell startup files or current environment.`,
    );
  }
  return token;
}

async function request(path, { method = "GET", body = null, token = null } = {}) {
  const headers = {
    Authorization: `Bearer ${token || getAsanaToken()}`,
  };
  if (body !== null) headers["Content-Type"] = "application/json";
  const res = await fetch(`${ASANA_API}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify({ data: body }),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!res.ok) {
    const detail = parsed?.errors?.[0]?.message || parsed?.raw || res.statusText;
    throw new Error(`Asana ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return parsed || {};
}

function enc(value) {
  return encodeURIComponent(value);
}

export async function getMe(token = null) {
  const result = await request("/users/me", { token });
  return result.data;
}

export async function getWorkspace(gid, token = null) {
  const result = await request(`/workspaces/${enc(gid)}?opt_fields=gid,name`, {
    token,
  });
  return result.data;
}

export async function getProject(gid, token = null) {
  const result = await request(
    `/projects/${enc(gid)}?opt_fields=gid,name,workspace.gid,workspace.name`,
    { token },
  );
  return result.data;
}

export async function getSection(gid, token = null) {
  const result = await request(`/sections/${enc(gid)}?opt_fields=gid,name,project.gid`, {
    token,
  });
  return result.data;
}

export async function getCustomField(gid, token = null) {
  const result = await request(`/custom_fields/${enc(gid)}?opt_fields=gid,name,type`, {
    token,
  });
  return result.data;
}

export async function getTask(gid, token = null) {
  const result = await request(
    `/tasks/${enc(gid)}?opt_fields=gid,name,completed,permalink_url,assignee.gid,assignee.name,memberships.section.name,custom_fields.name,custom_fields.display_value,custom_type_status_option.gid,custom_type_status_option.name,modified_at,completed_at`,
    { token },
  );
  return result.data;
}

export async function searchTasks(params, token = null) {
  const { workspace, ...queryParams } = params;
  const query = new URLSearchParams(queryParams);
  const result = await request(`/workspaces/${enc(workspace)}/tasks/search?${query}`, {
    token,
  });
  return result.data || [];
}

export async function findTaskByTicket(config, ticket, token = null) {
  const fieldGid = config.asana?.customFields?.ticket?.gid;
  const common = {
    workspace: config.asana.workspace.gid,
    "projects.any": config.asana.project?.gid,
    opt_fields:
      "gid,name,completed,permalink_url,memberships.section.name,custom_fields.name,custom_fields.display_value",
    limit: "10",
  };
  if (fieldGid) {
    const tasks = await searchTasks(
      {
        ...common,
        [`custom_fields.${fieldGid}.value`]: ticket,
      },
      token,
    );
    if (tasks[0]) return tasks[0];
    const broadTasks = await searchTasks(
      {
        workspace: config.asana.workspace.gid,
        [`custom_fields.${fieldGid}.value`]: ticket,
        opt_fields: common.opt_fields,
        limit: common.limit,
      },
      token,
    );
    if (broadTasks[0]) return broadTasks[0];
  }
  const textMatches = await searchTasks(
    {
      ...common,
      text: ticket,
    },
    token,
  );
  return textMatches.find((task) =>
    (task.custom_fields || []).some((field) => field.display_value === ticket) ||
      task.name?.includes(ticket),
  ) || textMatches[0] || null;
}

export async function moveTaskToSection(taskGid, sectionGid, token = null) {
  const result = await request(`/sections/${enc(sectionGid)}/addTask`, {
    method: "POST",
    body: { task: taskGid },
    token,
  });
  return result.data;
}

export async function completeTask(taskGid, completed = true, token = null) {
  const result = await request(`/tasks/${enc(taskGid)}`, {
    method: "PUT",
    body: { completed },
    token,
  });
  return result.data;
}

export async function updateTask(taskGid, data, token = null) {
  const result = await request(`/tasks/${enc(taskGid)}`, {
    method: "PUT",
    body: data,
    token,
  });
  return result.data;
}

export async function setTaskStatus(taskGid, statusKey, config = loadConfig(), token = null) {
  const optionGid =
    config.asana?.statusOptions?.[statusKey];
  if (!optionGid) {
    throw new Error(`No Asana status option configured for ${statusKey}`);
  }
  return updateTask(taskGid, { custom_type_status_option: optionGid }, token);
}

export async function addTaskComment(taskGid, text, token = null) {
  const result = await request(`/tasks/${enc(taskGid)}/stories`, {
    method: "POST",
    body: { text },
    token,
  });
  return result.data;
}

export async function validateAsanaConfig(config = loadConfig()) {
  const token = getAsanaToken(config);
  const checks = [];
  const me = await getMe(token);
  checks.push({ kind: "user", ok: true, gid: me.gid, name: me.name });

  if (config.asana?.workspace?.gid) {
    const workspace = await getWorkspace(config.asana.workspace.gid, token);
    checks.push({ kind: "workspace", ok: true, gid: workspace.gid, name: workspace.name });
  }
  if (config.asana?.project?.gid) {
    const project = await getProject(config.asana.project.gid, token);
    checks.push({ kind: "project", ok: true, gid: project.gid, name: project.name });
  }
  for (const [name, section] of Object.entries(config.asana?.sections || {})) {
    if (!section?.gid) continue;
    const found = await getSection(section.gid, token);
    checks.push({ kind: "section", key: name, ok: true, gid: found.gid, name: found.name });
  }
  for (const [name, field] of Object.entries(config.asana?.customFields || {})) {
    if (!field?.gid) continue;
    try {
      const found = await getCustomField(field.gid, token);
      checks.push({
        kind: "customField",
        key: name,
        ok: true,
        gid: found.gid,
        name: found.name,
      });
    } catch (e) {
      if (name === "ticket") throw e;
      checks.push({
        kind: "customField",
        key: name,
        ok: false,
        gid: field.gid,
        warning: e.message,
      });
    }
  }
  return { me, checks };
}
