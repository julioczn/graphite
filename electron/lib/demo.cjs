// Builds a small demo SQLite database on first run so there is always
// something to explore (ships a demo.db for the same reason).
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const FIRST = [
  "Ana",
  "Bruno",
  "Carla",
  "Diego",
  "Elisa",
  "Felipe",
  "Gabriela",
  "Hugo",
  "Isabela",
  "João",
  "Larissa",
  "Marcos",
  "Natália",
  "Otávio",
  "Paula",
  "Rafael",
];
const LAST = [
  "Silva",
  "Souza",
  "Costa",
  "Pereira",
  "Almeida",
  "Ferreira",
  "Rocha",
  "Lima",
  "Gomes",
  "Ribeiro",
];
const CITIES = [
  "São Paulo",
  "Curitiba",
  "Porto Alegre",
  "Recife",
  "Belo Horizonte",
  "Florianópolis",
  "Salvador",
  "Manaus",
];
const PRODUCTS = [
  ["Teclado mecânico", "Periféricos", 459.9],
  ["Mouse sem fio", "Periféricos", 129.9],
  ['Monitor 27"', "Monitores", 1899.0],
  ["Monitor ultrawide", "Monitores", 3299.0],
  ['Notebook 14"', "Computadores", 5499.0],
  ["Mini PC", "Computadores", 2799.0],
  ["Headset", "Áudio", 349.9],
  ["Caixa de som", "Áudio", 219.9],
  ["SSD 1TB", "Armazenamento", 489.0],
  ["HD externo 2TB", "Armazenamento", 529.0],
  ["Webcam 1080p", "Periféricos", 279.0],
  ["Hub USB-C", "Acessórios", 199.0],
];
const STATUS = ["pendente", "pago", "enviado", "entregue", "cancelado"];

function ensureDemo(dir) {
  const file = path.join(dir, "demo.sqlite");
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  let seed = 42;
  const rand = () =>
    (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rand() * a.length)];

  db.exec(`
    create table customers (
      id integer primary key,
      name text not null,
      email text unique not null,
      city text,
      created_at text not null
    );
    create table products (
      id integer primary key,
      name text not null,
      category text not null,
      price numeric not null,
      stock integer not null default 0
    );
    create table orders (
      id integer primary key,
      customer_id integer not null references customers(id),
      status text not null,
      created_at text not null
    );
    create table order_items (
      id integer primary key,
      order_id integer not null references orders(id),
      product_id integer not null references products(id),
      quantity integer not null,
      unit_price numeric not null
    );
    create index idx_orders_customer on orders(customer_id);
    create index idx_items_order on order_items(order_id);
    create view order_totals as
      select o.id as order_id, c.name as customer, o.status, o.created_at,
             round(sum(i.quantity * i.unit_price), 2) as total
      from orders o
      join customers c on c.id = o.customer_id
      join order_items i on i.order_id = o.id
      group by o.id;
  `);

  db.exec("begin");
  const insC = db.prepare(
    "insert into customers (name, email, city, created_at) values (?, ?, ?, ?)",
  );
  for (let i = 1; i <= 120; i++) {
    const f = pick(FIRST),
      l = pick(LAST);
    const day = new Date(
      Date.UTC(2025, 0, 1) + Math.floor(rand() * 600) * 864e5,
    );
    insC.run(
      `${f} ${l}`,
      `${f}.${l}.${i}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "") +
        "@exemplo.com",
      pick(CITIES),
      day.toISOString().slice(0, 10),
    );
  }
  const insP = db.prepare(
    "insert into products (name, category, price, stock) values (?, ?, ?, ?)",
  );
  for (const [n, c, p] of PRODUCTS) insP.run(n, c, p, Math.floor(rand() * 200));
  const insO = db.prepare(
    "insert into orders (customer_id, status, created_at) values (?, ?, ?)",
  );
  const insI = db.prepare(
    "insert into order_items (order_id, product_id, quantity, unit_price) values (?, ?, ?, ?)",
  );
  for (let o = 1; o <= 600; o++) {
    const when = new Date(
      Date.UTC(2025, 3, 1) + Math.floor(rand() * 540 * 864e5),
    );
    insO.run(
      1 + Math.floor(rand() * 120),
      pick(STATUS),
      when.toISOString().replace("T", " ").slice(0, 19),
    );
    const lines = 1 + Math.floor(rand() * 4);
    for (let l = 0; l < lines; l++) {
      const pi = Math.floor(rand() * PRODUCTS.length);
      insI.run(o, pi + 1, 1 + Math.floor(rand() * 3), PRODUCTS[pi][2]);
    }
  }
  db.exec("commit");
  db.close();
  return file;
}

module.exports = { ensureDemo };
