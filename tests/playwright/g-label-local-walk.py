"""Local G-LABEL acceptance. Uses actual demo APIs; only report telemetry is route-fixtured.

Run: python tests\\playwright\\g-label-local-walk.py http://127.0.0.1:7273
No Azure authentication, directory calls, deployment or billable model requests.
"""
import csv
import io
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1]
if urlparse(BASE).hostname != "127.0.0.1" or urlparse(BASE).scheme != "http":
    raise ValueError("This acceptance harness is restricted to an explicit loopback demo URL.")
OUT = Path("docs/images/deployment-walk")
OUT.mkdir(parents=True, exist_ok=True)
GROUP = "7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
PEOPLE = ["abcdef01-2345-4678-9abc-def012345671", "abcdef01-2345-4678-9abc-def012345672"]
TAG = "WBS-1001.01"
HEADERS = {"authorization": "Bearer demo-editor", "content-type": "application/json"}
REPORT = {
    "scope": "Loopback demo with real UI, user-tag settings/person/suggestion APIs and in-memory stores. "
             "Browser developer-report telemetry is a controlled fixture; not Azure or sync/ledger proof.",
    "checks": [], "screenshots": [], "fixtureQueries": [], "pageErrors": [], "nonLocalRequests": [],
}
completed = False


def check(name, condition, detail=None):
    REPORT["checks"].append({"name": name, "passed": bool(condition), "detail": detail})
    if not condition:
        raise AssertionError(name)


def shot(page, filename, section=None, region=None):
    page.wait_for_timeout(300)
    page.evaluate("""() => {
      if (!document.getElementById('local-evidence-note')) {
        const note = document.createElement('p');
        note.id = 'local-evidence-note';
        note.className = 'notice notice-info';
        note.textContent = 'Local demo acceptance — synthetic identities and report telemetry; not Azure evidence.';
        document.querySelector('.page')?.prepend(note);
      }
      for (const identity of document.querySelectorAll('.user-identity')) {
        const id = identity.querySelector('.user-identity-id')?.textContent || '';
        const admin = id.endsWith('00e1');
        const name = identity.querySelector('.user-identity-name');
        const upn = identity.querySelector('.user-identity-upn');
        if (name) name.textContent = admin ? 'Example administrator' : 'Example team member';
        if (upn) upn.textContent = admin ? 'administrator@example.invalid' : 'member@example.invalid';
      }
      const ids = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        if (!text.parentElement?.closest('script,style')) text.textContent = text.textContent.replace(ids, '[synthetic object ID]');
      }
      for (const input of document.querySelectorAll('input')) {
        input.value = input.value.replace(ids, '[synthetic object ID]');
      }
      for (const toast of document.querySelectorAll('.toast')) toast.hidden = true;
    }""")
    # Neutralize synthetic IDs in screenshot text only; underlying API data remains unchanged.
    if section:
        section.scroll_into_view_if_needed()
    if region:
        region.evaluate("""el => {
          const note = document.createElement('p');
          note.className = 'notice notice-info';
          note.textContent = 'Local acceptance — synthetic identities / telemetry, not Azure evidence.';
          el.prepend(note);
        }""")
        region.screenshot(path=str(OUT / filename))
    else:
        page.screenshot(path=str(OUT / filename), full_page=False)
    REPORT["screenshots"].append(str(OUT / filename).replace("\\", "/"))


with sync_playwright() as p:
    req = p.request.new_context(base_url=BASE, extra_http_headers=HEADERS)
    unlimited = {"tokensPerMinute": None, "tokenQuota": None, "tokenQuotaPeriod": None}
    group = {
        "groupId": GROUP, "displayName": "Example engineering team", "backendId": "foundry-eus2",
        "priority": 100, "chargebackId": None,
        "budget": {"mode": "autoScale", "perUser": {"amount": 50, "currency": "USD", "period": "monthly"}, "groupCap": None},
        "restrictedFamiliesApproved": False, "surfaces": ["code"],
        "cacheProfile": {"expectedCacheReadPercent": 85, "basis": "suggested"},
        "familyPolicy": {"aggregateLimits": {"person": unlimited, "group": unlimited},
                         "families": {"sonnet": {"models": ["claude-sonnet-4-5"], "person": unlimited, "group": unlimited}}},
    }
    r = req.post("/api/groups", data=json.dumps(group))
    check("Synthetic onboarded group available", r.status in (201, 409), r.status)
    for person in PEOPLE:
        current = req.get(f"/api/user-tags/people/{person}")
        if current.json()["exists"]:
            reset = req.put(f"/api/user-tags/people/{person}", data=json.dumps({"tag": None}),
                            headers={**HEADERS, "if-match": current.headers["etag"]})
            assert reset.status == 200
    current = req.get("/api/user-tags/settings")
    if current.json()["exists"]:
        reset = req.put("/api/user-tags/settings", data=json.dumps({"label": "User tag"}),
                        headers={**HEADERS, "if-match": current.headers["etag"]})
        assert reset.status == 200
    browser = p.chromium.launch(channel="msedge", headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1080}, accept_downloads=True)
    page = context.new_page()
    page.on("pageerror", lambda e: REPORT["pageErrors"].append(str(e)))
    page.on("request", lambda r: REPORT["nonLocalRequests"].append(r.url)
            if urlparse(r.url).hostname not in ("127.0.0.1", None) else None)
    try:
        page.goto(f"{BASE}/api/console-v3#/user-tags")
        field_name = page.get_by_label("Field name", exact=True)
        expect(field_name).to_be_visible()
        if field_name.input_value() != "WBS ID":
            field_name.fill("WBS ID")
            with page.expect_response(lambda r: r.url.endswith("/api/user-tags/settings") and r.request.method == "PUT") as saved:
                page.get_by_role("button", name="Save field name", exact=True).click()
            check("Actual UI saves deployment label", saved.value.status in (200, 201), saved.value.status)
        page.reload()
        expect(field_name).to_have_value("WBS ID")
        expect(page.get_by_role("heading", name="WBS ID", exact=True)).to_be_visible()
        cfg = req.get("/api/user-tags/settings")
        check("Label persists across browser reload via real settings API",
              cfg.json()["label"] == "WBS ID" and cfg.json()["exists"] and bool(cfg.headers.get("etag")))
        shot(page, "admin-wbs-field-name.png")

        page.get_by_label("Onboarded group", exact=True).select_option(GROUP)
        expect(page.get_by_role("button", name="Demo member 1", exact=True)).to_be_visible()
        page.get_by_role("button", name="Demo member 1", exact=True).click()
        tag_input = page.locator('input[list]').first
        expect(page.get_by_text("Current WBS ID", exact=True)).to_be_visible()
        tag_input.fill(TAG)
        save_tag = page.get_by_role("button", name="Save tag", exact=True)
        expect(save_tag).to_be_enabled()
        with page.expect_response(lambda r: "/api/user-tags/people/" in r.url and r.request.method == "PUT") as tagged:
            save_tag.click()
        check("First individual tag saved through actual UI/API", tagged.value.status in (200, 201))
        page.get_by_role("button", name="Demo member 2", exact=True).click()
        expect(page.get_by_text("Current WBS ID", exact=True)).to_be_visible()
        tag_input.fill("WBS")
        datalist_id = tag_input.get_attribute("list")
        expect(page.locator(f'datalist[id="{datalist_id}"] option[value="{TAG}"]')).to_have_count(1)
        choices = page.locator(f'datalist[id="{datalist_id}"] option').evaluate_all("els => els.map(e => e.value)")
        check("Typing loads actual saved-tag suggestions", TAG in choices, choices)
        tag_input.press("ArrowDown")
        tag_input.press("Enter")
        if tag_input.input_value() != TAG:
            # Headless Edge does not expose its native datalist popup to Playwright. Pick the
            # actual datalist value through the controlled input, not an invented fixture value.
            tag_input.fill(choices[choices.index(TAG)])
            REPORT["suggestionSelection"] = "Actual datalist option selected by filling its value; native headless popup selection unavailable."
        else:
            REPORT["suggestionSelection"] = "Native datalist selected with ArrowDown / Enter."
        with page.expect_response(lambda r: "/api/user-tags/people/" in r.url and r.request.method == "PUT") as second:
            save_tag.click()
        check("Saved suggestion assigned individually to second user", second.value.status in (200, 201))
        for person in PEOPLE:
            check("Actual stored tag is unchanged for synthetic person", req.get(f"/api/user-tags/people/{person}").json()["tag"] == TAG)
        page.reload()
        expect(page.get_by_label("Field name", exact=True)).to_have_value("WBS ID")
        expect(page.locator("table tbody tr")).to_have_count(2)
        shot(page, "admin-wbs-tagged-people.png",
             region=page.locator("section.section").filter(has=page.get_by_role("heading", name="Tagged people", exact=True)))

        raw = req.get("/api/v3/chargeback/developers?period=month").json()
        check("Real demo JSON keeps stable userTag key",
              "userTag" in raw["data"]["columns"] and "WBS ID" not in raw["data"]["columns"])

        def telemetry(route):
            response = route.fetch()
            body = response.json()
            query = parse_qs(urlparse(route.request.url).query)
            selected = query.get("chargeback", [""])[0]
            REPORT["fixtureQueries"].append({"chargeback": selected, "limit": query.get("limit", [""])[0]})
            rows = [
                {"person": PEOPLE[0], "userTag": TAG, "requests": 12, "tokensSpent": 42000,
                 "knownListUsd": "1.25", "listUsd": "1.25", "unpricedRequests": 0, "completeness": "complete"},
                {"person": PEOPLE[1], "userTag": "CC-900", "requests": 4, "tokensSpent": 8000,
                 "knownListUsd": "0.50", "listUsd": "0.50", "unpricedRequests": 0, "completeness": "complete"},
            ]
            if selected:
                rows = [r for r in rows if r["userTag"] == selected]
            body["data"].update({"columns": list(rows[0]) if rows else ["person", "userTag"],
                                 "rows": rows, "truncated": False, "page": {"matched": len(rows)}})
            route.fulfill(response=response, json=body)

        page.route("**/api/v3/chargeback/developers?*", telemetry)
        page.goto(f"{BASE}/api/console-v3#/chargeback")
        expect(page.get_by_label("WBS ID", exact=True)).to_be_visible()
        page.get_by_role("tab", name="Developers", exact=True).click()
        expect(page.locator("th").filter(has_text=re.compile("^WBS ID$"))).to_have_count(1)
        page.get_by_label("WBS ID", exact=True).fill(TAG)
        expect(page.locator("table tbody tr").filter(has_text=TAG)).to_have_count(1)
        page.wait_for_timeout(650)
        check("Configured report filter sends stable chargeback parameter",
              any(q["chargeback"] == TAG for q in REPORT["fixtureQueries"]))
        expect(page.locator("table tbody tr").filter(has_text="CC-900")).to_have_count(0)
        shot(page, "admin-wbs-chargeback-report.png",
             region=page.locator("section.panel").filter(has=page.get_by_role("heading", name="Breakdown", exact=True)))
        page.get_by_role("heading", name="Chargeback", exact=True).scroll_into_view_if_needed()
        shot(page, "admin-wbs-chargeback-filter.png")
        with page.expect_download() as download:
            page.get_by_role("button", name=re.compile("Export CSV")).click()
        csv_path = OUT / "admin-wbs-chargeback.csv"
        download.value.save_as(str(csv_path))
        contents = csv_path.read_text(encoding="utf8")
        rows = list(csv.reader(io.StringIO("\n".join(line for line in contents.splitlines() if not line.startswith("#")))))
        check("Actual browser download uses WBS ID display header", "WBS ID" in rows[0] and "userTag" not in rows[0], rows[0])
        check("Downloaded CSV preserves matching tag values", len(rows) == 2 and rows[1][rows[0].index("WBS ID")] == TAG)
        # Remove even synthetic raw object IDs from the publishable CSV artifact.
        contents = contents.replace(PEOPLE[0], "Example member A").replace(PEOPLE[1], "Example member B")
        csv_path.write_text(contents, encoding="utf8")
        REPORT["csv"] = str(csv_path).replace("\\", "/")
        REPORT["jsonMachineKeys"] = raw["data"]["columns"]

        page.goto(f"{BASE}/api/console-v3#/groups/new")
        expect(page.get_by_label("Entra group Object ID", exact=True)).to_be_visible()
        page.get_by_label("Entra group Object ID", exact=True).fill("8b2d3c4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e")
        page.get_by_label("Display name", exact=True).fill("Example research team")
        backend = page.get_by_label("Foundry backend", exact=True)
        backend.select_option("foundry-eus2")
        page.get_by_role("button", name="Continue", exact=True).click()
        expect(page.get_by_label("Per-user budget (monthly)", exact=True)).to_be_visible()
        page.get_by_role("button", name="Continue", exact=True).click()
        page.get_by_role("button", name="Admit sonnet", exact=True).click()
        page.get_by_role("button", name="Admit haiku", exact=True).click()
        expected = {}
        for family, person_tpm, group_tpm in [("sonnet", 2500, 10000), ("haiku", 5000, 20000)]:
            for scope, tpm, quota in [("person", person_tpm, 200000), ("group", group_tpm, 900000)]:
                page.get_by_label(f"{family} · {scope} tokens per minute", exact=True).fill(str(tpm))
                page.get_by_label(f"{family} · {scope} token quota", exact=True).fill(str(quota))
                page.get_by_label(f"{family} · {scope} quota period", exact=True).select_option("Monthly")
            model_row = page.locator(".family-models > li").filter(has=page.locator(".family-name", has_text=family))
            before = model_row.locator(".tag-removable").first.inner_text().strip()
            add_model = page.get_by_label(f"Add a {family} model", exact=True)
            choices = add_model.locator("option").evaluate_all("els => els.map(e => e.value).filter(Boolean)")
            check(f"{family} exact allowed-model control is available", bool(choices))
            chosen = choices[0]
            add_model.select_option(chosen)
            page.get_by_role("button", name=f"Remove {before}", exact=True).click()
            expect(model_row.locator(".tag-removable")).to_have_count(1)
            expect(model_row.locator(".tag-removable")).to_contain_text(chosen)
            expected[family] = [chosen]
        shot(page, "admin-family-token-limits-models.png", page.get_by_role("heading", name="Models and rate limits", exact=True))
        page.get_by_role("button", name="Continue", exact=True).click()
        page.get_by_text("Request (JSON)", exact=True).click()
        body = json.loads(page.locator("pre.code-block").inner_text())
        for family, person_tpm, group_tpm in [("sonnet", 2500, 10000), ("haiku", 5000, 20000)]:
            actual = body["familyPolicy"]["families"][family]
            check(f"{family} reviewed JSON preserves person/group TPM and quotas",
                  actual["person"] == {"tokensPerMinute": person_tpm, "tokenQuota": 200000, "tokenQuotaPeriod": "Monthly"}
                  and actual["group"] == {"tokensPerMinute": group_tpm, "tokenQuota": 900000, "tokenQuotaPeriod": "Monthly"})
            check(f"{family} reviewed JSON contains only the explicitly allowed model", actual["models"] == expected[family], actual["models"])
        check("No per-family dollar budgets introduced",
              all(set(f) == {"models", "person", "group"} for f in body["familyPolicy"]["families"].values()))
        REPORT["familyPolicy"] = body["familyPolicy"]
        check("No browser runtime errors", not REPORT["pageErrors"], REPORT["pageErrors"])
        check("No outbound browser requests", not REPORT["nonLocalRequests"])
        completed = True
    finally:
        context.close()
        browser.close()
        req.dispose()
        REPORT["passed"] = completed and bool(REPORT["checks"]) and all(c["passed"] for c in REPORT["checks"])
        (OUT / "admin-g-label-acceptance.json").write_text(json.dumps(REPORT, indent=2), encoding="utf8")
        print(json.dumps(REPORT, indent=2))
