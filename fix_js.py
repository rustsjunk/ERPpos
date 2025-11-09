import re, sys
p = r'static\\js\\script.js'
with open(p, 'r', encoding='utf-8', errors='replace') as f:
    s = f.read()
# 1) Title: Invoice -> Receipt
s = s.replace("title.textContent = Invoice ", "title.textContent = Receipt ")
# 2) Meta line: use ASCII separators
s = re.sub(r"if\(meta\) meta\.textContent = Time: .*?Cashier: .*?;", "if(meta) meta.textContent = Time:  | Customer:  | Cashier: ;", s)
# 3) Item line replacement to include attributes line
old = "name.innerHTML = <div class=\\'fw-semibold\\'></div><div class=\\'small text-muted\\'>x @ </div>;"
new = (
    "const attrs = it.attributes || {};\n"
    "        const colour = attrs.Colour || attrs.Color || '';\n"
    "        const size = attrs.Size || '';\n"
    "        const attrLine = (colour or size) and f\"Colour: {colour or '-'}  Size: {size or '-'}\" or ''\n"
    "        name.innerHTML = <div class=\\'fw-semibold\\'></div> + (attrLine?<div class=\\'small text-muted\\'></div>:'') + <div class=\\'small text-muted\\'>x @ </div>;"
)
s = s.replace(old, new)
# 4) Enrich items with variant attributes before render
start = s.find("async function openInvoiceDetail(invId){")
if start != -1:
    end = s.find("\n}", start)
    # expand to include the function block fully by finding the next function or IIFE (best-effort)
    next_fn = s.find("\nfunction ", start+1)
    if next_fn == -1:
        next_fn = s.find("\n( function|\(function)", start+1)
    if next_fn != -1:
        end = next_fn
    new_fn = '''async function openInvoiceDetail(invId){
  try{
    const r = await fetch('/api/invoices/' + encodeURIComponent(invId));
    const d = await r.json();
    if(d && d.status==='success'){
      const inv = d.invoice;
      try{
        const ids = Array.from(new Set((inv.items||[]).map(it=>it.item_code).filter(Boolean)));
        if(ids.length){
          const r2 = await fetch('/api/variant-info?ids=' + encodeURIComponent(ids.join(',')));
          const dj = await r2.json();
          if(dj && dj.status==='success'){
            const vmap = dj.variants || {};
            (inv.items||[]).forEach(it=>{
              const v = vmap[it.item_code];
              if(v && v.attributes){ it.attributes = Object.assign({}, it.attributes||{}, v.attributes); }
              if((!it.item_name || it.item_name==='') && v && v.name){ it.item_name = v.name; }
            });
          }
        }
      }catch(_){ }
      renderInvoiceDetail(inv);
      const o=document.getElementById('invoiceDetailOverlay');
      if(o){ o.style.display='flex'; o.style.visibility='visible'; o.style.opacity='1'; }
    }
  }catch(e){ err('load invoice detail failed', e); }
}
'''
    s = s[:start] + new_fn + s[end:]
with open(p, 'w', encoding='utf-8', newline='\n') as f:
    f.write(s)
print('script.js updated')
