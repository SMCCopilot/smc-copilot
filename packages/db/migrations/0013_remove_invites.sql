-- 0013: remove the invite system. Sign-up is open: a wallet sign-in, the disclaimer and the 18+ confirmation are the
-- only gates. Drops the redemption function (also the one that 0012 locked down), both invite tables and the
-- profiles flag that recorded a redemption. The sample invite that 0009 seeded goes with the table.
drop function if exists redeem_invite(text, uuid);
drop table if exists invite_redemptions;
drop table if exists invite_codes;
alter table profiles drop column if exists invite_redeemed_at;
delete from feature_flags where key = 'signup.open';
