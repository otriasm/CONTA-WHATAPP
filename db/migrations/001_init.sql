-- Conta v2 · esquema inicial (tablas del lienzo «Servicios y APIs por pantalla»).
-- Reglas de datos: nunca se guarda CURP ni domicilio; la CSF y los tickets se borran al leerlos.

create table businesses (
  id                  text primary key,
  name                text not null,
  rfc                 text not null,
  tax_system          text not null,
  timezone            text not null default 'America/Mexico_City',
  privacy_notice_url  text not null,
  product_description text not null,
  product_key         text not null,
  unit_key            text not null,
  unit_name           text not null,
  product_kind        text not null check (product_kind in ('bienes', 'servicios', 'arrendamiento')),
  active              boolean not null default false,
  created_at          timestamptz not null default now()
);

-- A1 · emisor en Facturapi. Las llaves viven en la bóveda; aquí solo la referencia.
create table issuers (
  business_id              text primary key references businesses(id),
  facturapi_org_id         text not null,
  facturapi_live_key_ref   text,
  csd_expires_at           timestamptz,
  manifest_signed_at       timestamptz,
  pending_steps            text[] not null default '{}'
);

-- A2 · número del negocio en coexistencia
create table wa_numbers (
  phone_number_id  text primary key,
  business_id      text not null references businesses(id),
  waba_id          text not null,
  display_number   text not null,
  token_ref        text not null,
  status           text not null default 'connected', -- connected | disconnected (ER09)
  updated_at       timestamptz not null default now()
);

-- A4 · reglas versionadas; cada solicitud fija la versión con la que empezó
create table emission_rules (
  business_id         text not null references businesses(id),
  version             int  not null,
  mode                text not null check (mode in ('automatico', 'aprobacion')),
  max_amount          numeric(12, 2) not null,
  max_ticket_age_days int  not null,
  created_at          timestamptz not null default now(),
  primary key (business_id, version)
);

create table operators (
  id           text primary key,
  business_id  text not null references businesses(id),
  name         text not null,
  phone        text not null,
  active       boolean not null default true
);
create index operators_phone_idx on operators (phone) where active;

create table shifts (
  id           bigserial primary key,
  business_id  text not null references businesses(id),
  operator_id  text not null references operators(id),
  opened_at    timestamptz not null default now(),
  closed_at    timestamptz
);
create unique index shifts_open_idx on shifts (business_id) where closed_at is null;

-- Receptores por negocio. pseudo_id es el único identificador que sale a analítica.
create table receptors (
  id                     text primary key,
  business_id            text not null references businesses(id),
  phone                  text not null,
  pseudo_id              text not null,
  rfc                    text,
  legal_name             text,
  zip                    text,
  tax_system             text,
  email                  text,
  facturapi_customer_id  text,
  sat_validated_at       timestamptz,
  unique (business_id, phone)
);

create table requests (
  id                       text primary key,
  business_id              text not null references businesses(id),
  receptor_id              text not null references receptors(id),
  state                    text not null,
  rule_version             int  not null,
  rule_snapshot            jsonb not null,
  pending_fiscal           jsonb,
  ticket                   jsonb,
  cfdi_use                 text,
  stamp_attempts           int not null default 0,
  stamp_retries            int not null default 0,
  ticket_read_attempts     int not null default 0,
  sat_validation_attempts  int not null default 0,
  approval_reason          text,
  approval_requested_at    timestamptz,
  approved_by_operator_id  text references operators(id),
  issued_by                text,
  invoice_id               text,
  last_inbound_at          timestamptz not null,
  opened_at                timestamptz not null,
  confirmed_at             timestamptz,
  updated_at               timestamptz not null default now(),
  foreign key (business_id, rule_version) references emission_rules (business_id, version)
);
-- Una sola solicitud abierta por receptor y negocio
create unique index requests_open_idx on requests (business_id, receptor_id)
  where state not in ('entregada', 'abandonada');

-- ER20 · un folio se factura una sola vez por negocio
create table ticket_folios (
  business_id  text not null references businesses(id),
  folio        text not null,
  request_id   text not null references requests(id),
  invoiced_at  timestamptz not null,
  primary key (business_id, folio)
);

create table invoices (
  id             text primary key,
  request_id     text not null references requests(id),
  business_id    text not null references businesses(id),
  receptor_id    text not null references receptors(id),
  facturapi_id   text not null unique,
  uuid           text,
  total          numeric(12, 2) not null,
  status         text not null,
  issued_by      text not null check (issued_by in ('automatico', 'operador')),
  operator_id    text references operators(id),
  created_at     timestamptz not null default now()
);
create index invoices_receptor_idx on invoices (business_id, receptor_id, created_at desc);

-- Copias propias del PDF y XML (A5, B5)
create table files (
  invoice_id  text not null references invoices(id),
  kind        text not null check (kind in ('pdf', 'xml')),
  storage_key text not null,
  primary key (invoice_id, kind)
);

create table approvals (
  id           bigserial primary key,
  request_id   text not null references requests(id),
  operator_id  text not null references operators(id),
  decision     text not null check (decision in ('aprobada', 'corregida', 'soporte')),
  decided_at   timestamptz not null default now()
);

create table support_cases (
  id          bigserial primary key,
  request_id  text not null references requests(id),
  context     jsonb not null,
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz
);

-- Mensajes editables sin desplegar (ER01–ER36)
create table error_catalog (
  code        text primary key,
  audience    text not null check (audience in ('receptor', 'operador', 'emisor')),
  message     text not null,
  updated_at  timestamptz not null default now()
);

create table daily_digests (
  business_id  text not null references businesses(id),
  digest_date  date not null,
  sent_at      timestamptz,
  primary key (business_id, digest_date)
);
