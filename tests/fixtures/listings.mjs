/**
 * Fixtures transcribed from real listings, so the parsers can be tested without
 * re-scraping Facebook.
 */

/**
 * Listing 1049705647676534, the one that reached the contact queue in the live
 * run of 2026-09-01 despite being a dealership. Facebook reported
 * vehicle_seller_type: null and dealership_name: null - the description is the
 * only thing that gives it away, which is exactly why the text pass exists.
 */
export const noahCarsDetailNode = {
  id: "1049705647676534",
  marketplace_listing_title: "Fiat uno way divino con A/C NOAHCARS‼️‼️‼️",
  custom_title: null,
  creation_time: 1756000000,
  condition: "USED",
  listing_price: { amount: "5990", currency: "USD", formatted_amount: "US$5990" },
  location_text: { text: "Montevideo, Montevideo" },
  marketplace_listing_category_id: "807311116002614",
  dealership_name: null,
  vehicle_odometer_data: { unit: "KILOMETERS", value: 118000 },
  vehicle_make_display_name: null,
  vehicle_model_display_name: null,
  vehicle_trim_display_name: null,
  vehicle_seller_type: null,
  vehicle_title_status: null,
  vehicle_is_paid_off: null,
  vehicle_number_of_owners: null,
  vehicle_condition: "USED",
  vehicle_transmission_type: null,
  vehicle_fuel_type: null,
  is_sold: false,
  is_live: true,
  is_pending: false,
  seller_id: "61550000000000",
  redacted_description:
    "Noah Cars\n" +
    "☑️Venta - Permuta -Financiación☑️\n" +
    "Fiat Uno Way 2015 con A/C, 118.000 km, muy buen estado.\n" +
    "Contamos con servicio de escribania y gestoria\n" +
    "Consulte financiacion",
};

/** An ordinary private sale, for the negative case. */
export const privateSaleDetailNode = {
  id: "2000000000000001",
  marketplace_listing_title: "Nissan March 2015",
  custom_title: null,
  creation_time: 1755000000,
  condition: "USED",
  listing_price: { amount: "7200", currency: "USD" },
  location_text: { text: "Canelones, Canelones" },
  dealership_name: null,
  vehicle_odometer_data: { unit: "KILOMETERS", value: 57000 },
  vehicle_make_display_name: "Nissan",
  vehicle_model_display_name: "March",
  vehicle_seller_type: "PRIVATE_SELLER",
  vehicle_is_paid_off: true,
  vehicle_number_of_owners: 1,
  is_sold: false,
  seller_id: "61550000000001",
  redacted_description:
    "Vendo mi Nissan March 2015, 57.000 km reales, único dueño, papeles al día, libre de deuda. " +
    "Permuto por moto. Escucho ofertas razonables.",
};
