-- Update Kassangas tenant with correct WhatsApp phone number ID and WABA ID(s)

-- Option 1: Update both possible WABA IDs for reference
UPDATE bot_tenants
SET whatsapp_phone_number_id = '1089350894265731',
    whatsapp_business_account_id = '445104179636568',
    updated_at = NOW()
WHERE client_phone = '254737245555';

-- If you want to test with the second WABA ID, run this after the first test:
-- UPDATE bot_tenants
-- SET whatsapp_business_account_id = '4485513761735551',
--     updated_at = NOW()
-- WHERE client_phone = '254737245555';

-- You can also update by tenant id if needed:
-- WHERE id = '<KASSANGAS_TENANT_ID>';
