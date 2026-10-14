import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { domToMarkdown } from '../src/markdown.js';

test('domToMarkdown converts rendered Gemini HTML', async (t) => {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    t.skip(`no Playwright Chromium available: ${err.message.split('\n')[0]}`);
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="r">
      <h2>Title</h2>
      <p>Some <strong>bold</strong>, <em>italic</em> and <code>inline</code> <a href="https://x.dev">link</a>.</p>
      <ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
      <ol><li>first</li><li>second</li></ol>
      <code-block><div class="code-block-decoration"><span>Python</span><button>Copy</button></div>
        <pre><code>def f():\n\n\n    return 1  </code></pre></code-block>
      <table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>
    </div>`);
    const md = await page.evaluate(`(${domToMarkdown.toString()})(document.getElementById('r'))`);
    assert.match(md, /^## Title/);
    assert.match(md, /Some \*\*bold\*\*, \*italic\* and `inline` \[link\]\(https:\/\/x\.dev\)\./);
    assert.match(md, /- one\n- two\n  - nested/);
    assert.match(md, /1\. first\n2\. second/);
    // Code keeps its blank lines and trailing spaces, and picks up the language label.
    assert.ok(md.includes('```python\ndef f():\n\n\n    return 1  \n```'), md);
    assert.ok(!md.includes('Copy'));
    assert.match(md, /\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  } finally {
    await browser.close();
  }
});
