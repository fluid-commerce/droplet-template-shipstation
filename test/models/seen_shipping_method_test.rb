require "test_helper"

describe SeenShippingMethod do
  fixtures(:companies)

  let(:company) { companies(:acme) }

  describe ".record!" do
    it "creates a seen record with count 1 and the example order" do
      SeenShippingMethod.record!(company: company, title: "Express", order_number: "ORD-1")
      seen = company.seen_shipping_methods.find_by(fluid_shipping_title: "Express")
      _(seen.seen_count).must_equal 1
      _(seen.example_order_number).must_equal "ORD-1"
    end

    it "increments the count and keeps the first example order on repeat" do
      SeenShippingMethod.record!(company: company, title: "Express", order_number: "ORD-1")
      SeenShippingMethod.record!(company: company, title: "Express", order_number: "ORD-2")
      seen = company.seen_shipping_methods.find_by(fluid_shipping_title: "Express")
      _(seen.seen_count).must_equal 2
      _(seen.example_order_number).must_equal "ORD-1"
    end

    it "does nothing for a blank title" do
      SeenShippingMethod.record!(company: company, title: "", order_number: "ORD-1")
      _(company.seen_shipping_methods.count).must_equal 0
    end

    it "never raises when tracking fails" do
      # Raises inside record!; the test fails if the error escapes the rescue.
      company.stub(:seen_shipping_methods, ->(*) { raise "boom" }) do
        SeenShippingMethod.record!(company: company, title: "X")
      end
      _(company.seen_shipping_methods.count).must_equal 0
    end
  end
end
