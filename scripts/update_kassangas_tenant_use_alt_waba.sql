-- Update Kassangas tenant to use the alternate WABA ID
UPDATE bot_tenants
SET whatsapp_business_account_id = '4485513761735551',
    updated_at = NOW()
WHERE client_phone = '254737245555';

-- If you want to revert, set whatsapp_business_account_id back to '445104179636568'.
