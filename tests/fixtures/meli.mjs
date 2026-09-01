/**
 * Forma de un resultado de /sites/MLU/search, según la documentación de
 * MercadoLibre. NO está tomado de una respuesta real: la búsqueda requiere
 * credenciales y todavía no las tenemos, así que el mapeo se testea contra esta
 * forma y el round-trip HTTP queda sin verificar hasta que haya una app.
 */
export const meliResult = (over = {}) => ({
  id: "MLU123456789",
  title: "Volkswagen Gol 1.6 Trend 2012",
  price: 8200,
  currency_id: "USD",
  available_quantity: 1,
  condition: "used",
  permalink: "https://auto.mercadolibre.com.uy/MLU-123456789-volkswagen-gol-16-trend-2012-_JM",
  thumbnail: "https://http2.mlstatic.com/D_123-MLU.jpg",
  seller: { id: 987654321, nickname: "NO_DEBE_PERSISTIRSE" },
  address: { state_name: "Montevideo", city_name: "Montevideo" },
  attributes: [
    { id: "BRAND", value_name: "Volkswagen" },
    { id: "MODEL", value_name: "Gol" },
    { id: "VEHICLE_YEAR", value_name: "2012" },
    { id: "KILOMETERS", value_name: "145.000 km" },
    { id: "FUEL_TYPE", value_name: "Nafta" },
    { id: "TRANSMISSION", value_name: "Manual" },
    { id: "TRIM", value_name: "Trend" },
  ],
  ...over,
});

/** Comparables para un Gol 2012, con un par que no lo son. */
export const golComparables = [
  meliResult({ id: "MLU1", price: 7_800 }),
  meliResult({ id: "MLU2", price: 8_200 }),
  meliResult({ id: "MLU3", price: 8_500 }),
  meliResult({ id: "MLU4", price: 8_900 }),
  meliResult({ id: "MLU5", price: 9_400 }),
  meliResult({ id: "MLU6", price: 9_900 }),
  // en pesos: no compara contra un aviso en dólares
  meliResult({ id: "MLU7", price: 350_000, currency_id: "UYU" }),
  // otro modelo
  meliResult({ id: "MLU8", price: 8_000, attributes: [
    { id: "BRAND", value_name: "Volkswagen" }, { id: "MODEL", value_name: "Polo" }, { id: "VEHICLE_YEAR", value_name: "2012" },
  ]}),
  // fuera de la banda de años
  meliResult({ id: "MLU9", price: 12_500, attributes: [
    { id: "BRAND", value_name: "Volkswagen" }, { id: "MODEL", value_name: "Gol" }, { id: "VEHICLE_YEAR", value_name: "2021" },
  ]}),
];
