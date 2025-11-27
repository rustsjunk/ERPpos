# Quick Changes Reference

## Server Changes (pos_server.py)

### Location: `/api/item_matrix` endpoint (~line 1007-1038)

**What changed**: Added `v.image_url` to the SELECT query

```python
qv = f"""
  SELECT v.item_id,
         v.name,
         v.image_url,  # ← ADDED THIS LINE
         (SELECT price_effective FROM v_item_prices p WHERE p.item_id=v.item_id) AS rate,
         COALESCE((SELECT qty FROM stock s WHERE s.item_id=v.item_id AND s.warehouse='{POS_WAREHOUSE}'), 0) AS qty
  FROM items v
  WHERE v.parent_id=? AND v.active=1 AND v.is_template=0
"""
```

**And updated variant dict creation** (~line 1035):

```python
# OLD: variants[key] = { 'item_id': r['item_id'], 'item_name': r['name'], 'rate': ..., 'qty': ... }
# NEW:
variant_image = _absolute_image_url(r['image_url']) if r['image_url'] else None
variants[key] = { 'item_id': r['item_id'], 'item_name': r['name'], 'rate': ..., 'qty': ..., 'image': variant_image }
```

---

## Frontend Changes (static/js/script.js)

### Location 1: `renderVariantMatrix()` function (~line 1443+)

**What changed**: Added click handler on color column header to switch images

```javascript
// In the color column cell creation:
tc.addEventListener('click', () => {
  const firstVarKey = Object.keys(m.variants||{}).find(k => k.startsWith(color+'|'));
  if(firstVarKey){
    const firstVar = m.variants[firstVarKey];
    if(firstVar && firstVar.image){
      const im = document.getElementById('productImage');
      if(im) im.style.backgroundImage = `url('${firstVar.image}')`;
    }
  }
});
tc.style.cursor = 'pointer';  // Make it obvious it's clickable
```

### Location 2: `addVariantToCart()` function (~line 1471+)

**What changed**: Use variant image instead of parent image

```javascript
// OLD:
// image: item.image || null,

// NEW:
const variantImage = (variantRec && variantRec.image) ? variantRec.image : (item.image || null);
// ...
image: variantImage,
```

---

## How It Works

1. **Item Matrix API** returns each variant with its `image` URL
2. **Color Click** in matrix finds first variant of that color and sets its image as preview
3. **Add to Cart** uses the variant's image (from the variant record passed in)
4. **Cart Display** and **Checkout** automatically use the variant image stored on each cart item

---

## Testing Checklist

- [ ] Parent item opens with variant matrix
- [ ] Clicking a color in the matrix changes the product image preview
- [ ] Adding a variant to cart works (qty increases or new item added)
- [ ] Cart display shows variant images (different colors = different images)
- [ ] Checkout shows correct variant images in order summary
- [ ] Receipt/email shows variant images

