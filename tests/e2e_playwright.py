import os
import sys
from playwright.sync_api import sync_playwright

BASE_URL = os.environ.get("CADENCE_E2E_URL", "http://127.0.0.1:4280")
SHOT_DIR = os.environ.get("CADENCE_SHOT_DIR", os.path.join(os.getcwd(), "tests", "screenshots"))
os.makedirs(SHOT_DIR, exist_ok=True)


def run_e2e():
    console_errors = []
    page_errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        # Fulfill external demo CDN image cleanly when "Load images" is explicitly clicked
        tiny_png = (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x10\x00\x00\x00\x10\x08\x02\x00\x00\x00"
            b"\x90\x91h6\x00\x00\x00\x16IDATx\x9cc`\x18\x05\xa3`\x14\x8c\x82Q0\nF\xc1(\x00\x00\x08\x80\x00\x10\xe3\x89\xfc\xd8\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        page.route("https://cdn.cloudgrid.dev/**", lambda route: route.fulfill(status=200, content_type="image/png", body=tiny_png))

        print("1. Navigating to Cadence Auth screen...")
        page.goto(BASE_URL, wait_until="networkidle")
        page.get_by_role("button", name="Create Account").click()
        page.get_by_placeholder("Alex Rivera").fill("Alex Rivera")
        page.get_by_placeholder("alex@gmail.com").fill("alex@cadence.local")
        page.get_by_placeholder("••••••••").fill("CadencePass123!")
        page.get_by_role("button", name="Create Workspace").click()

        print("2. Verifying clean zero-fake-data onboarding and Real Email Connector...")
        page.get_by_text("Connect Your Real Email").first.wait_for(timeout=10000)
        page.get_by_role("button", name="Connect Real Email").first.click()
        page.get_by_role("dialog", name="Connect real email account").wait_for(timeout=5000)
        page.get_by_role("button", name="Outlook / M365", exact=True).click()
        page.get_by_role("button", name="Gmail", exact=True).click()
        # Verify smart email-domain auto-detection + OAuth2/AI configuration drawer
        page.get_by_placeholder("you@gmail.com").fill("alex@zoho.in")
        page.get_by_text("Server Settings (imap.zoho.in:993").wait_for(timeout=3000)
        page.get_by_role("button", name="Configure OAuth2 App / AI API Keys (Optional)").click()
        page.get_by_placeholder("OpenAI API Key").wait_for(timeout=3000)
        page.get_by_placeholder("Anthropic API Key").wait_for(timeout=3000)
        page.get_by_role("button", name="Close connect email modal").click()

        # Enable optional Developer Local Sandbox in Settings for offline full-workflow browser testing
        page.get_by_role("button", name="Settings").first.click()
        page.get_by_role("button", name="Accounts & Security").click()
        page.get_by_text("Developer / Offline Testing: Add Local Sandbox Mailbox").click()
        page.get_by_placeholder("Display Name").fill("Alex Rivera")
        page.get_by_placeholder("sandbox@cadence.local").fill("alex@cadence.local")
        page.get_by_label("Seed sample").check()
        page.get_by_role("button", name="Add Local Mailbox").click()
        page.get_by_text("Local sandbox mailbox added.").wait_for(timeout=5000)
        page.get_by_title("Inbox", exact=True).click()
        page.get_by_text("Q4 Synchronization Engine Architecture & Latency Targets").first.wait_for(timeout=10000)

        # Check horizontal overflow on desktop
        overflow_desktop = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
        assert not overflow_desktop, "Horizontal overflow detected on desktop!"

        # Open multi-message thread
        page.get_by_text("Q4 Synchronization Engine Architecture & Latency Targets").first.click()
        try:
            page.get_by_text("retry-backoff-notes.txt").wait_for(timeout=5000)
        except Exception:
            page.screenshot(path=os.path.join(SHOT_DIR, "debug-failure.png"))
            print("DEBUG CONSOLE ERRORS:", console_errors)
            print("DEBUG PAGE ERRORS:", page_errors)
            raise
        page.get_by_role("button", name="Expand all (3)").click()
        page.get_by_text("sync-latency-benchmark.csv").wait_for(timeout=5000)

        # Verify security warning & external image privacy controls on respective seeded emails
        page.get_by_text("Action Notice: Verify external domain certificate").first.click()
        page.get_by_text("Suspicious link(s) detected").wait_for(timeout=5000)

        page.get_by_text("Invoice #CG-2026-1142").first.click()
        page.get_by_text("External images were hidden to protect your privacy.").wait_for(timeout=5000)
        page.get_by_role("button", name="Load images").click()

        # Re-select main thread for clean screenshot
        page.get_by_text("Q4 Synchronization Engine Architecture & Latency Targets").first.click()
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SHOT_DIR, "desktop-light.png"))

        print("3. Testing Compose, Link Popover, Draft Autosave & Real Delivery...")
        page.get_by_title("Compose new message (C)").click()
        page.get_by_placeholder("Add recipient...").first.fill("alex@cadence.local")
        page.get_by_placeholder("Add recipient...").first.press("Enter")
        page.get_by_placeholder("Subject").fill("E2E Verified Dispatch")
        editor = page.locator(".ProseMirror").first
        editor.click()
        editor.fill("This message was composed, autosaved, and delivered through Cadence E2E verification.")
        # Test inline hyperlink popover instead of window.prompt
        page.get_by_role("button", name="Insert link").click()
        page.get_by_role("dialog", name="Insert hyperlink").wait_for(timeout=3000)
        page.get_by_role("button", name="Close link dialog").click()

        page.get_by_text("Saved", exact=True).wait_for(timeout=5000)
        page.get_by_role("button", name="Send", exact=True).click()
        page.get_by_text("Message queued to send").wait_for(timeout=5000)

        # Wait for undo-send window (8s) + worker (2s) and check Inbox delivery
        page.wait_for_timeout(11000)
        page.get_by_text("E2E Verified Dispatch").first.wait_for(timeout=8000)

        # Test Inline Quick Reply in Reading Pane
        page.get_by_text("E2E Verified Dispatch").first.click()
        page.get_by_role("button", name="Quick Reply", exact=True).click()
        page.get_by_label("Quick reply body").fill("Inline quick reply confirmed cleanly.")
        page.get_by_role("button", name="Send Reply", exact=True).click()
        page.get_by_text("Quick reply queued to send").wait_for(timeout=5000)
        page.get_by_role("button", name="Undo Send").click()
        page.get_by_text("Send cancelled — draft restored.").wait_for(timeout=5000)
        # Close restored composer draft
        page.get_by_role("button", name="Close composer").click()

        # Test reversible Archive + Undo Toast on the open thread in ReadingPane
        page.get_by_role("article", name="Conversation reader").get_by_role("button", name="Archive").click()
        page.get_by_text("Archived (1)").wait_for(timeout=5000)
        page.get_by_role("button", name="Undo", exact=True).click()
        page.get_by_text("Restored to Inbox.").wait_for(timeout=5000)

        print("4. Testing Search Operators...")
        search_box = page.locator("#cadence-global-search")
        search_box.fill("from:elena has:attachment")
        search_box.press("Enter")
        page.get_by_text("Q4 Synchronization Engine Architecture & Latency Targets").first.wait_for(timeout=5000)
        page.get_by_role("button", name="Clear search").click()

        print("5. Testing Contacts, Rules Lifecycle, Admin Console, Sync Logs & Dark Mode...")
        page.get_by_role("button", name="Contacts").click()
        page.get_by_text("Elena Vance").wait_for(timeout=5000)

        page.get_by_role("button", name="Rules & Filters").click()
        page.get_by_role("button", name="Create Rule").click()
        page.get_by_placeholder("Rule name (e.g. 'Archive Receipts')").fill("Highlight Elena")
        page.get_by_placeholder("Value...").fill("elena")
        page.get_by_role("button", name="Preview Matches").click()
        page.get_by_text("Preview: 1 existing message(s) match this rule").wait_for(timeout=5000)
        page.get_by_role("button", name="Activate Rule").click()
        page.get_by_role("button", name="Run Now").click()
        page.get_by_text("matched and updated").wait_for(timeout=5000)
        page.get_by_role("button", name="Execution Logs").click()
        page.get_by_text("Highlight Elena").first.wait_for(timeout=5000)

        # Verify Shared Info Vault (Google Maps location + attachment) & Scheduled 5 AM Mailer
        page.get_by_role("button", name="Shared Info & Files Vault", exact=False).click()
        page.get_by_role("button", name="Add Info / Location Card").click()
        page.get_by_placeholder("e.g. Office Location & Parking").fill("HQ Google Maps Pin")
        page.get_by_placeholder("e.g. 123 Park Street, Kolkata or 22.5726,88.3639").fill("22.5726,88.3639")
        page.locator("input[type='file']").first.set_input_files(
            [{"name": "daily-note.txt", "mimeType": "text/plain", "buffer": b"Scheduled daily briefing"}]
        )
        page.get_by_text("Saved reusable automation attachment").wait_for(timeout=5000)
        page.get_by_role("button", name="Save to Vault").click()
        page.get_by_text("Preview Google Maps Link").wait_for(timeout=5000)

        page.get_by_role("button", name="Scheduled & Recurring Mail", exact=False).click()
        page.get_by_role("button", name='Quick Preset: Daily 5:00 AM "Hi" + Attachment').click()
        page.get_by_placeholder("manager@company.com, team@company.com").fill("alex@cadence.local")
        page.get_by_role("button", name="Activate Scheduled Email").click()
        page.get_by_text("Daily 5:00 AM Check-in + Attachment").first.wait_for(timeout=5000)
        page.get_by_role("button", name="Send Now").first.click()
        page.get_by_text('Dispatched "Daily 5:00 AM Check-in + Attachment" now').wait_for(timeout=8000)

        # New Next-Gen Workspace Apps: Tasks, Calendar, Attachment Library, Team Desk
        print("5b. Testing Tasks, Calendar, Attachments & Collaboration Team Desk...")
        nav = page.get_by_role("complementary", name="Primary navigation")
        nav.get_by_role("button", name="Tasks").click()
        page.get_by_placeholder("Add a task...").fill("Verify Q4 SLA")
        page.get_by_role("button", name="Create Task").click()
        page.get_by_text("Verify Q4 SLA").wait_for(timeout=5000)

        nav.get_by_role("button", name="Calendar").click()
        page.get_by_role("button", name="New Event").click()
        page.get_by_placeholder("Event title").fill("Architecture Sync")
        page.get_by_role("button", name="Save Event").click()
        page.get_by_text("Architecture Sync").wait_for(timeout=5000)

        nav.get_by_role("button", name="Attachments").click()
        page.get_by_text("retry-backoff-notes.txt").first.wait_for(timeout=5000)

        nav.get_by_role("button", name="Team Desk").click()
        page.get_by_role("button", name="Share a mailbox").click()
        page.locator("[role='dialog'] select").select_option(label="alex@cadence.local")
        page.get_by_placeholder("Shared inbox name (e.g. Support Desk)").fill("Support Desk")
        page.get_by_role("button", name="Create Shared Inbox").click()
        page.get_by_text("Support Desk").first.wait_for(timeout=5000)
        page.get_by_text("Q4 Synchronization Engine Architecture & Latency Targets").first.click()
        page.get_by_text("Shared Conversation").wait_for(timeout=5000)
        page.get_by_text("Confirmed on my end. Schema freeze").first.wait_for(timeout=5000)
        page.get_by_placeholder("Write private team note...").fill("Internal triage note verified")
        page.get_by_placeholder("Write private team note...").press("Enter")
        page.get_by_text("Internal triage note verified").wait_for(timeout=5000)
        page.get_by_placeholder("Write external reply from alex@cadence.local...").fill("Confirmed via Team Desk shared reply.")
        page.get_by_role("button", name="Send Shared Reply").click()
        page.get_by_text("Sent shared reply via alex@cadence.local").wait_for(timeout=5000)

        # Admin Console (Mode A: Domains, DNS Assistant, Observability, Backups & Hosted Mailbox creation)
        page.get_by_role("button", name="Administration").click()
        page.get_by_text("Independent Mail Service Health & Telemetry").wait_for(timeout=5000)
        page.get_by_role("button", name="Domains & DNS").click()
        page.get_by_placeholder("yourdomain.com", exact=True).fill("cadence-test.local")
        page.get_by_label("Activate immediately as an Internal/Private domain without requiring public DNS TXT verification first").check()
        page.get_by_role("button", name="Add Domain").click()
        page.get_by_text("cadence-test.local").first.wait_for(timeout=5000)
        page.get_by_text("TXT (DKIM)").wait_for(timeout=5000)
        page.get_by_role("button", name="Security & Backups").click()
        page.get_by_role("button", name="Create Backup Now").click()
        page.get_by_text("Verified point-in-time SQLite & attachments backup created.").wait_for(timeout=5000)

        page.get_by_role("button", name="Connect Real Email").first.click()
        page.get_by_role("button", name="Create Own Hosted Email Address").click()
        page.get_by_placeholder("alex", exact=True).fill("ops")
        page.get_by_role("button", name="Create Hosted Mailbox").click()
        page.get_by_text("ops@cadence-test.local").first.wait_for(timeout=5000)

        page.get_by_role("button", name="Settings").first.click()
        page.get_by_role("button", name="Inbox & Categories").click()
        page.get_by_placeholder("Add custom category...").fill("Vip Billing")
        page.get_by_role("button", name="Add Category").click()
        page.get_by_role("button", name="Delete category Vip Billing").wait_for(timeout=5000)
        page.get_by_role("button", name="Accounts & Security").click()
        page.get_by_text("Security & Privacy Center").wait_for(timeout=5000)
        page.get_by_role("button", name="Purge Expired Now").click()
        page.get_by_text("No expired Trash or Spam messages past your retention window.").wait_for(timeout=5000)
        page.get_by_role("button", name="Sync Logs").first.click()
        page.get_by_text("Recent Synchronization History").wait_for(timeout=5000)
        page.get_by_role("button", name="Appearance").click()
        page.get_by_role("button", name="dark", exact=True).click()
        page.wait_for_timeout(300)
        theme_attr = page.evaluate("document.documentElement.getAttribute('data-theme')")
        assert theme_attr == "dark", f"Expected dark theme, got {theme_attr}"

        # Return to mail in dark mode for visual inspection
        page.get_by_title("Inbox", exact=True).click()
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(SHOT_DIR, "desktop-dark.png"))

        print("6. Testing Mobile Responsive Layout (390x844)...")
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(400)
        overflow_mobile = page.evaluate("document.documentElement.scrollWidth > window.innerWidth")
        assert not overflow_mobile, "Horizontal overflow detected on mobile!"
        page.screenshot(path=os.path.join(SHOT_DIR, "mobile-dark.png"))

        browser.close()

    assert len(console_errors) == 0, f"Console errors observed: {console_errors}"
    assert len(page_errors) == 0, f"Page errors observed: {page_errors}"
    print("ALL PLAYWRIGHT E2E CHECKS PASSED WITH ZERO CONSOLE/PAGE ERRORS!")


if __name__ == "__main__":
    try:
        run_e2e()
    except Exception as exc:
        print(f"E2E FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
