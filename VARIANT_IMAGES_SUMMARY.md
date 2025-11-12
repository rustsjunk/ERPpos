# Variant-Specific Images Implementation — Summary

## Feature
Display variant-specific images in the item matrix and checkout, with image switching when colors are clicked.

## Problem Solved
- Parent items had a single image, but variants in ERPNext have different images per color
- Clicking a color in the matrix now shows that color's variant image instead of the parent image
- Cart and checkout now display the correct variant image (not just parent image)

## Changes Made

### 1. Server Endpoint Update (`pos_server.py` — `/api/item_matrix`)

**Change**: Added `v.image_url` to the variant query and include it in the response payload.

```python
# Before: only item_id, name, rate, qty
SELECT v.item_id, v.name, (rate query), (qty query)

# After: includes image_url
SELECT v.item_id, v.name, v.image_url, (rate query), (qty query)
```

**Result**: Each variant in the matrix data now includes:
```json
{
  "variants": {
    "Red|Standard|36": {
      "item_id": "SHOE-RED-36",
      "item_name": "Red 36",
      "rate": 79.0,
      "qty": 5,
      "image": "https://erp.example.com/files/red-shoe.png"  // ← NEW
    }
  }
}
```

### 2. Frontend Updates (`static/js/script.js`)

#### `renderVariantMatrix()` function
**Change**: Added click handler to color column header to switch product image.

```javascript
// When user clicks a color, find the first variant with that color and display its image
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
```

**Result**: Clicking a color in the matrix updates the product image preview immediately.

#### `addVariantToCart()` function
**Change**: Use variant image instead of parent image when adding to cart.

```javascript
// Before: image: item.image || null
// After:
const variantImage = (variantRec && variantRec.image) ? variantRec.image : (item.image || null);
cart.push({
  ...
  image: variantImage,  // Use variant-specific image
  ...
});
```

**Result**: When variants are added to cart, each item displays its own image (not parent image).

## User Experience Flow

1. **Browse tiles**: Parent item displays its (or first variant's) image
2. **Click parent**: Item matrix opens
3. **Click color**: Matrix updates to show that color's image preview
4. **Add variant**: Variant is added to cart with its specific image
5. **View cart**: Each cart item shows its variant image
6. **Checkout**: Receipt/invoice displays variant-specific images

## Database Schema

No changes required. The `items` table already has `image_url` column for each variant/template.

## API Response Example

### GET `/api/item_matrix?item=Adesso-Dila`

```json
{
  "status": "success",
  "data": {
    "item": "Adesso-Dila",
    "colors": ["Forest", "Metallic Croc"],
    "widths": ["Standard"],
    "sizes": ["36 EU", "37 EU", "38 EU"],
    "variants": {
      "Forest|Standard|36 EU": {
        "item_id": "Adesso-Dila-A8103-Forest-36 EU",
        "item_name": "Adesso Dila Forest 36",
        "rate": 79.0,
        "qty": 5,
        "image": "https://erp.example.com/files/forest-shoe.png"
      },
      "Metallic Croc|Standard|36 EU": {
        "item_id": "Adesso-Dila-A8104-Metallic Croc-36 EU",
        "item_name": "Adesso Dila Metallic 36",
        "rate": 79.0,
        "qty": 3,
        "image": "https://erp.example.com/files/metallic-shoe.png"
      }
    },
    "stock": {
      "Forest|Standard|36 EU": 5,
      "Metallic Croc|Standard|36 EU": 3
    }
  }
}
```

## Testing

1. **Start Flask server:**
   ```bash
   py main.py
   ```

2. **Open POS in browser and test:**
   - Click a parent item (e.g., "Adesso-Dila")
   - Matrix opens with color headers
   - Click on a color (e.g., "Forest") → product image should change to forest variant image
   - Click a size/qty cell → variant added to cart
   - Open cart → each item displays its variant image
   - Proceed to checkout → receipt shows variant images

3. **Verify variant images in DB:**
   ```sql
   SELECT item_id, image_url FROM items 
   WHERE parent_id='Adesso-Dila' AND is_template=0
   LIMIT 3;
   ```
   Should return different image URLs per variant (not all NULL or same as parent).

## Files Changed

1. **`pos_server.py`**
   - Modified `/api/item_matrix` endpoint
   - Added `v.image_url` to SELECT query
   - Each variant in response now includes `"image"` field

2. **`static/js/script.js`**
   - Modified `renderVariantMatrix()` function to add click handler on color headers
   - Modified `addVariantToCart()` function to use variant image instead of parent image

## Notes

- Images are resolved to absolute URLs using `_absolute_image_url()` helper (same as tiles)
- If variant image is NULL, falls back to parent image
- Color click handler updates the preview image in the product overlay
- Cart and checkout automatically inherit variant image from cart items

## Future Enhancements

1. **Image carousel**: Show all variant colors as clickable thumbnails (not just click header)
2. **Zoom preview**: Add image zoom/lightbox on variant image click
3. **Image gallery**: If variant has multiple images, show gallery in matrix detail view
4. **Cache strategy**: Cache variant images locally for offline mode

---

**Status**: ✅ Complete. Variant images now display correctly in matrix, cart, and checkout.
