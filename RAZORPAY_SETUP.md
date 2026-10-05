# Razorpay setup

1. Add your Razorpay credentials to `.env`:
   - `RAZORPAY_KEY_ID=rzp_test_...`
   - `RAZORPAY_KEY_SECRET=...`
2. Restart the Node server after changing `.env`.
3. Keep the secret key server-side only. Never put `RAZORPAY_KEY_SECRET` in EJS/JavaScript.
4. The cart checkout uses Razorpay Checkout and the server verifies the payment signature before creating the order and reducing stock.
5. Add a delivery address before checkout.

For production, use live keys only after completing Razorpay account/KYC requirements.
