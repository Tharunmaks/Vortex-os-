import test from 'node:test';
import assert from 'node:assert';
import { parseHTML, walk } from '../public/js/engine/html.js';
import { parseStylesheet, computeStyles } from '../public/js/engine/css.js';
import { layoutDocument } from '../public/js/engine/layout.js';

const measure = (font, text) => text.length * parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)[1]) * 0.5;
function render(html, css = '', width = 400) {
  const env = { vw: width, vh: 600 };
  const doc = parseHTML(html);
  computeStyles(doc.children[0], [parseStylesheet(css, env)], env);
  return { doc, out: layoutDocument(doc.children[0], { width, height: 600, measure, getImage: () => ({ state: 'error', w: 0, h: 0 }) }) };
}
const texts = (out) => out.cmds.filter((c) => c.t === 'text');

test('engine: HTML parser builds a forgiving tree', () => {
  const doc = parseHTML('<p>one<p>two<ul><li>a<li>b</ul><table><tr><td>1<td>2</table>after&amp;<script>x<y</script>');
  const tags = [];
  walk(doc, (el) => { tags.push(el.tag); });
  assert.deepEqual(tags.filter((t) => t === 'p').length, 2);
  assert.equal(tags.filter((t) => t === 'li').length, 2);
  assert.equal(tags.filter((t) => t === 'td').length, 2);
});

test('engine: scripts and handlers are inert — there is no JS engine', () => {
  const { out } = render('<p onclick="x()">hi</p><script>document.title="x"</script>');
  assert.deepEqual(texts(out).map((t) => t.text), ['hi']);
});

test('engine: margins collapse and text wraps', () => {
  const { out } = render('<p>aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo</p><p>x</p>');
  const t = texts(out);
  assert.ok(t.length >= 3, 'wrapped onto several lines');
  const gap = t.at(-1).y - t.at(-2).y;
  assert.ok(gap < 16 * 1.2 + 16 + 4, `adjacent 1em margins collapse (gap=${gap})`);
});

test('engine: cascade, specificity, !important and var()', () => {
  const { doc } = render('<div id=a class=b>x</div>', ':root{--c:#00ff00}.b{color:red}#a{color:var(--c)}div{color:blue!important}');
  let color;
  walk(doc, (el) => { if (el.tag === 'div') color = el.style.color; });
  assert.equal(color, '#0000ff');
});

test('engine: flex row shares width, space-between, auto margins', () => {
  const { out } = render('<div style="display:flex"><div style="flex:1;background:#f00">a</div><div style="flex:1;background:#00f">b</div></div>');
  const boxes = out.cmds.filter((c) => c.t === 'box');
  assert.equal(boxes.length, 2);
  assert.ok(Math.abs(boxes[0].w - boxes[1].w) < 1);
  assert.ok(Math.abs(boxes[0].w + boxes[1].w - 384) < 1);
});

test('engine: tables size columns and place cells side by side', () => {
  const { out } = render('<table><tr><td>a<td>bbbbbbbbbb</table>');
  const t = texts(out);
  assert.equal(t.length, 2);
  assert.ok(t[1].x > t[0].x);
  assert.equal(Math.round(t[0].y), Math.round(t[1].y));
});

test('engine: media queries follow the viewport', () => {
  const css = 'p{color:red}@media (max-width:300px){p{color:blue}}';
  let c1;
  let c2;
  walk(render('<p>x</p>', css, 500).doc, (e) => { if (e.tag === 'p') c1 = e.style.color; });
  walk(render('<p>x</p>', css, 250).doc, (e) => { if (e.tag === 'p') c2 = e.style.color; });
  assert.equal(c1, '#ff0000');
  assert.equal(c2, '#0000ff');
});

test('engine: anchors are recorded for #fragment links', () => {
  const { out } = render('<p>top</p><h2 id=later>Later</h2>');
  assert.ok(out.anchors.later > 0);
});

test('engine: inputs and buttons that are flex items still become controls', () => {
  const { out } = render('<form><div style="display:flex;gap:8px"><input name=q style="flex:1"><button>Go</button></div></form>');
  const kinds = out.controls.map((c) => c.ctl).sort();
  assert.deepEqual(kinds, ['button', 'text']);
  const input = out.controls.find((c) => c.ctl === 'text');
  assert.ok(input.w > 200, `input flexes to fill the row (w=${input.w})`);
});

test('engine: hidden inputs take no space', () => {
  const { out } = render('<form><input type=hidden name=a value=1><p>x</p></form>');
  assert.equal(out.controls.length, 0);
});

test('engine: the Vortex engine has no script runtime and ignores page markup tricks', () => {
  const { out } = render('<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">trap</a><style>body{background:url(javascript:alert(1))}</style><p>safe</p>');
  assert.ok(texts(out).some((t) => t.text === 'safe'));
});
