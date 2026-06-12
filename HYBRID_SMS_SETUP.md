# Hybrid SMS Model - Setup Guide
## MissedCall Responder: Platform-Managed + BYOK Options

---

## Overview

The hybrid model gives you flexibility:
- **Starter/Growth plans**: Use your Telnyx account (platform-managed)
- **Pro/Enterprise plans**: Option to Bring Your Own Key (BYOK)

---

## How It Works

### Option 1: Platform-Managed (Starter/Growth Plans)

```
┌─────────────────────────────────────────┐
│           YOUR TELNYX ACCOUNT           │
│                                         │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │Number 1 │ │Number 2 │ │Number 3 │   │
│  │(TenantA)│ │(TenantB)│ │(TenantC)│   │
│  └─────────┘ └─────────┘ └─────────┘   │
│                                         │
│  You pay Telnyx: ~$1-3/month per number │
│  + per-message costs                    │
└─────────────────────────────────────────┘
           │
           │ SMS/calls
           ▼
┌─────────────────────────────────────────┐
│         TENANT PAYS YOU                 │
│         (via credit system)             │
│                                         │
│  • Starter: 500 credits/month included  │
│  • Growth: 1500 credits/month included  │
│  • Additional credits: $0.02/credit     │
└─────────────────────────────────────────┘
```

**Your Margin:** Difference between what tenant pays in credits and what Telnyx charges you.

---

### Option 2: BYOK (Pro/Enterprise Plans)

```
┌─────────────────────────────────────────┐
│         TENANT'S TELNYX ACCOUNT         │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │   Their own phone number        │    │
│  │   Their own API key             │    │
│  │   They pay Telnyx directly      │    │
│  └─────────────────────────────────┘    │
│                                         │
│  Tenant pays Telnyx: ~$1-3/month        │
│  + per-message costs                    │
└─────────────────────────────────────────┘
           │
           │ SMS/calls via their API key
           ▼
┌─────────────────────────────────────────┐
│         TENANT PAYS YOU                 │
│         (platform subscription only)    │
│                                         │
│  • Pro: $149/month                      │
│  • Enterprise: $299/month               │
│  • No credit charges for SMS            │
└─────────────────────────────────────────┘
```

**Your Revenue:** Pure subscription fee, no SMS cost overhead.

---

## Setup Steps

### Step 1: Run the Database Migration

Execute this SQL in your Supabase SQL Editor:

```sql
-- File: supabase/migrations/003_sms_byok_hybrid.sql
-- (Already created in your workspace)
```

This creates:
- `tenant_sms_settings` table (BYOK configuration)
- `phone_number_pool` table (platform-managed numbers)
- Updated subscription plans with SMS model flags

---

### Step 2: Deploy Updated Edge Function

Deploy the updated `telnyx-sms` function:

```bash
cd C:\Users\Administrator\.openclaw\workspace\missedcallresponder
supabase functions deploy telnyx-sms
```

---

### Step 3: Add Phone Numbers to Pool

For platform-managed numbers, add them to the pool:

```sql
-- Add numbers you purchased in your Telnyx account
INSERT INTO phone_number_pool (phone_number, area_code, region, telnyx_number_id, status)
VALUES 
  ('+13215550101', '321', 'Florida', 'telnyx-id-1', 'available'),
  ('+13215550102', '321', 'Florida', 'telnyx-id-2', 'available'),
  ('+14075550103', '407', 'Florida', 'telnyx-id-3', 'available');
```

---

### Step 4: Configure Subscription Plans

Plans are already configured in the migration:

| Plan | Price | SMS Model | BYOK Allowed |
|------|-------|-----------|--------------|
| Starter | $49/mo | Platform | No |
| Growth | $99/mo | Platform | No |
| Pro | $149/mo | Hybrid | Yes |
| Enterprise | $299/mo | BYOK | Yes |

---

## Tenant Onboarding Flow

### For Starter/Growth (Platform-Managed):

```
1. Tenant signs up
2. MintBird webhook triggers provisioning
3. System assigns phone number from pool:
   SELECT * FROM assign_phone_number('tenant-uuid', '321');
4. Tenant gets assigned number
5. SMS usage deducts from their credits
```

### For Pro/Enterprise (BYOK Option):

```
1. Tenant signs up
2. During onboarding, they see BYOK option
3. If they choose BYOK:
   a. They sign up at telnyx.com
   b. Buy their own phone number
   c. Enter API key in settings
   d. System validates the key
4. All SMS goes through their Telnyx account
5. No credit deduction for SMS
```

---

## API Endpoints

### Assign Phone Number (Super Admin Only)

```http
POST /rest/v1/rpc/assign_phone_number
{
  "p_tenant_id": "tenant-uuid",
  "p_area_code": "321"  -- optional
}

Response:
{
  "phone_number": "+13215550101",
  "success": true,
  "message": "Phone number assigned successfully"
}
```

### Release Phone Number (Super Admin Only)

```http
POST /rest/v1/rpc/release_phone_number
{
  "p_tenant_id": "tenant-uuid"
}

Response:
{
  "phone_number": "+13215550101",
  "success": true,
  "message": "Phone number released successfully"
}
```

### Update Tenant SMS Settings (Tenant Admin)

```http
PATCH /rest/v1/tenant_sms_settings?tenant_id=eq.{tenant_id}
{
  "use_own_telnyx_key": true,
  "telnyx_api_key_encrypted": "encrypted-api-key",
  "telnyx_phone_number": "+13215550199"
}
```

---

## Credit Costs

Configure in `system_config` table:

```sql
INSERT INTO system_config (key, value) VALUES
('credit_costs', '{
  "sms": 1,
  "ai_message": 5,
  "appointment_booking": 3,
  "call": 1
}'::jsonb);
```

---

## Monitoring

### Check Phone Number Pool Status

```sql
SELECT 
  status,
  COUNT(*) as count
FROM phone_number_pool
GROUP BY status;
```

### View Tenant SMS Settings

```sql
SELECT 
  t.name as tenant_name,
  t.phone_number,
  s.use_own_telnyx_key,
  s.fallback_to_platform
FROM tenants t
LEFT JOIN tenant_sms_settings s ON t.id = s.tenant_id;
```

---

## Fallback Behavior

When BYOK is enabled with fallback:

1. System tries tenant's Telnyx API key first
2. If that fails (invalid key, insufficient funds, etc.)
3. System falls back to platform's Telnyx account
4. Uses platform-managed number from pool
5. Credits are deducted for fallback SMS

This ensures messages always go through even if tenant's account has issues.

---

## Security Notes

- API keys are encrypted at rest
- Tenant can only see their own SMS settings
- Super admin can manage all numbers
- Audit logs track all phone number assignments/releases

---

## Next Steps

1. ✅ Run database migration
2. ✅ Deploy updated edge function
3. ⬜ Buy phone numbers in your Telnyx account
4. ⬜ Add numbers to pool
5. ⬜ Test platform-managed flow
6. ⬜ Test BYOK flow (with test Telnyx account)
7. ⬜ Update tenant onboarding UI

---

**Date Created:** June 10, 2026
**Status:** Ready for deployment
