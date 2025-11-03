let items = [];
let cart = [];
let customers = [];

// Initialize the POS system
document.addEventListener('DOMContentLoaded', function() {
    loadItems();
    loadCustomers();
    setupEventListeners();
});

// Load items from ERPNext
async function loadItems() {
    try {
        const response = await fetch('/api/items');
        const data = await response.json();
        if (data.status === 'success') {
            items = data.items;
            displayItems(items);
        }
    } catch (error) {
        console.error('Error loading items:', error);
    }
}

// Load customers from ERPNext
async function loadCustomers() {
    try {
        const response = await fetch('/api/customers');
        const data = await response.json();
        if (data.status === 'success') {
            customers = data.customers;
            const customerSelect = document.getElementById('customerSelect');
            customers.forEach(customer => {
                const option = document.createElement('option');
                option.value = customer.name;
                option.textContent = customer.customer_name;
                customerSelect.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading customers:', error);
    }
}

// Display items in the grid
function displayItems(itemsToDisplay) {
    const itemsGrid = document.getElementById('itemsGrid');
    itemsGrid.innerHTML = '';
    
    itemsToDisplay.forEach(item => {
        const itemCard = document.createElement('div');
        itemCard.className = 'col';
        itemCard.innerHTML = `
            <div class="card item-card h-100">
                <div class="card-body">
                    <h5 class="card-title">${item.item_name}</h5>
                    <p class="card-text">₹${item.standard_rate}</p>
                    <p class="card-text"><small>${item.stock_uom}</small></p>
                </div>
            </div>
        `;
        itemCard.onclick = () => addToCart(item);
        itemsGrid.appendChild(itemCard);
    });
}

// Add item to cart
function addToCart(item) {
    const existingItem = cart.find(cartItem => cartItem.item_code === item.name);
    
    if (existingItem) {
        existingItem.qty += 1;
        existingItem.amount = existingItem.qty * existingItem.rate;
    } else {
        cart.push({
            item_code: item.name,
            item_name: item.item_name,
            qty: 1,
            rate: item.standard_rate,
            amount: item.standard_rate
        });
    }
    
    updateCartDisplay();
}

// Update cart display
function updateCartDisplay() {
    const cartItems = document.getElementById('cartItems');
    const cartTotal = document.getElementById('cartTotal');
    cartItems.innerHTML = '';
    
    let total = 0;
    
    cart.forEach(item => {
        const itemElement = document.createElement('div');
        itemElement.className = 'cart-item';
        itemElement.innerHTML = `
            <div>
                <div>${item.item_name}</div>
                <div class="text-muted">₹${item.rate}</div>
            </div>
            <div class="cart-item-quantity">
                <span class="quantity-btn" onclick="updateQuantity('${item.item_code}', -1)">-</span>
                <span>${item.qty}</span>
                <span class="quantity-btn" onclick="updateQuantity('${item.item_code}', 1)">+</span>
            </div>
        `;
        cartItems.appendChild(itemElement);
        total += item.amount;
    });
    
    cartTotal.textContent = `₹${total.toFixed(2)}`;
}

// Update item quantity
function updateQuantity(itemCode, change) {
    const item = cart.find(item => item.item_code === itemCode);
    if (item) {
        item.qty += change;
        if (item.qty <= 0) {
            cart = cart.filter(cartItem => cartItem.item_code !== itemCode);
        } else {
            item.amount = item.qty * item.rate;
        }
        updateCartDisplay();
    }
}

// Setup event listeners
function setupEventListeners() {
    // Search functionality
    document.getElementById('itemSearch').addEventListener('input', function(e) {
        const searchTerm = e.target.value.toLowerCase();
        const filteredItems = items.filter(item => 
            item.item_name.toLowerCase().includes(searchTerm)
        );
        displayItems(filteredItems);
    });
    
    // Checkout functionality
    document.getElementById('checkoutBtn').addEventListener('click', async function() {
        const customer = document.getElementById('customerSelect').value;
        const paymentMethod = document.getElementById('paymentMethod').value;
        
        if (!customer) {
            alert('Please select a customer');
            return;
        }
        
        if (cart.length === 0) {
            alert('Cart is empty');
            return;
        }
        
        const total = cart.reduce((sum, item) => sum + item.amount, 0);
        
        const saleData = {
            customer: customer,
            items: cart.map(item => ({
                item_code: item.item_code,
                qty: item.qty,
                rate: item.rate
            })),
            payments: [{
                mode_of_payment: paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1),
                amount: total
            }]
        };
        
        try {
            const response = await fetch('/api/create-sale', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(saleData)
            });
            
            const result = await response.json();
            
            if (result.status === 'success') {
                alert('Sale completed successfully!');
                cart = [];
                updateCartDisplay();
            } else {
                alert('Error: ' + result.message);
            }
        } catch (error) {
            console.error('Error creating sale:', error);
            alert('Error creating sale. Please try again.');
        }
    });
}