// Compiles the rendered APIM policy's C# expressions and runs them on test vectors.
// Shared by the gateway policy tests; PowerShell 7 supplies Newtonsoft.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";

export interface Vector {
  label: string;
  method: string;
  vars?: Record<string, unknown>;
  status?: number;
  policyId?: string;
  reason?: string;
  expected: unknown;
  json?: boolean;
  property?: string;
  // context.Request: the original URL's path and the request headers.
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

// Compile and execute the actual rendered C# expressions, not a TypeScript imitation.
// PowerShell 7 and its Newtonsoft assembly are already required by the repository.
export function runExpressions(methods: Record<string, string>, vectors: Vector[]): unknown[] {
  const bodies = Object.entries(methods).map(([name, source]) => {
    const body = source.startsWith("@{") ? source.slice(2, -1) : `return ${source.slice(2, -1)};`;
    return `public static object ${name}(Context context) { ${body} }`;
  }).join("\n");
  const source = `
using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
public class Bag : Dictionary<string, object> {
  public T GetValueOrDefault<T>(string key, T fallback) { return ContainsKey(key) ? (T)this[key] : fallback; }
}
public class Body { public string Text; public T As<T>() { return (T)(object)JObject.Parse(Text); } public T As<T>(bool preserveContent) { return As<T>(); } }
public interface IResponse { int StatusCode { get; } Body Body { get; } }
public class Response : IResponse { public int StatusCode { get; set; } public Body Body { get; set; } }
public class Error { public string Source = ""; public string PolicyId = ""; public string Reason = ""; }
public class Url { public string Path = ""; }
public class Headers : Dictionary<string, string> {
  public Headers() : base(StringComparer.OrdinalIgnoreCase) {}
  public string GetValueOrDefault(string key, string fallback) { return ContainsKey(key) ? this[key] : fallback; }
}
public class Request { public Url OriginalUrl = new Url(); public Headers Headers = new Headers(); public Body Body = new Body(); }
public class Context {
  public Bag Variables = new Bag();
  public Response Response = new Response();
  public Error LastError = new Error();
  public Request Request = new Request();
  public Guid RequestId = Guid.Parse("00000000-0000-0000-0000-000000000001");
}
public static class PolicyExpressions { ${bodies} }`;
  const script = `
$ErrorActionPreference = 'Stop'
$inputJson = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
$refs = @([Newtonsoft.Json.Linq.JObject].Assembly.Location, (Join-Path $PSHOME 'ref\\System.Collections.dll'), (Join-Path $PSHOME 'ref\\System.Linq.dll'), (Join-Path $PSHOME 'ref\\System.Text.RegularExpressions.dll'))
# Only suppress the assembly unification warning between PowerShell's bundled Newtonsoft
# and the host's System.Runtime. C# errors and every other warning remain failures.
Add-Type -TypeDefinition $inputJson.source -ReferencedAssemblies $refs -CompilerOptions '/nowarn:1701', '/langversion:7'
$results = @()
foreach ($v in $inputJson.vectors) {
  $ctx = [Context]::new()
  $ctx.Response.StatusCode = [int]$v.status
  $ctx.LastError.PolicyId = [string]$v.policyId
  $ctx.LastError.Reason = [string]$v.reason
  $ctx.Request.OriginalUrl.Path = [string]$v.path
  $ctx.Request.Body.Text = [string]$v.body
  if ($v.headers) { foreach ($name in $v.headers.Keys) { $ctx.Request.Headers[$name] = [string]$v.headers[$name] } }
  foreach ($key in $v.vars.Keys) {
    $value = $v.vars[$key]
    if ($key -eq 'ccofResolverResponse') {
      $response = [Response]::new()
      $response.StatusCode = [int]$value.status
      $response.Body = [Body]::new()
      $response.Body.Text = $value.body | ConvertTo-Json -Depth 50 -Compress
      $ctx.Variables[$key] = $response
    } elseif ($value -is [System.Collections.IDictionary] -or $value -is [array]) {
      $encoded = $value | ConvertTo-Json -Depth 50 -Compress
      $ctx.Variables[$key] = $encoded.PSObject.BaseObject
    } elseif ($key.EndsWith('Tpm')) { $ctx.Variables[$key] = [int]$value
    } elseif ($key.EndsWith('Quota')) { $ctx.Variables[$key] = [long]$value
    } else { $ctx.Variables[$key] = if ($null -eq $value) { $null } else { $value.PSObject.BaseObject } }
  }
  $method = [PolicyExpressions].GetMethod($v.method)
  try { $result = $method.Invoke($null, @($ctx)) } catch { throw ($v.label + ': ' + $_.Exception.ToString()) }
  if ($v.json) { $result = $result | ConvertFrom-Json -AsHashtable }
  $results += ,$result
}
ConvertTo-Json -InputObject $results -Depth 50 -Compress
`;
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: JSON.stringify({ source, vectors }),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4_000_000,
    env: { ...process.env, CCOF_LIVE_TESTS: "0" },
  });
  assert.equal(result.status, 0, `C# expression harness failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}
