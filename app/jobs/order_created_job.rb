class OrderCreatedJob < WebhookEventJob
  def process_webhook
    create_order_service = ShipHero::CreateOrder.new(params)
    result = create_order_service.call

    # if result.success?
    #   render json: { success: true, data: result.data }, status: :created
    # else
    #   render json: { success: false, error: result.error }, status: :unprocessable_entity
    # end
  rescue StandardError => e
    Rails.logger.error("Error creating order: #{e.message}")
    render json: { success: false, error: 'Internal server error' }, status: :internal_server_error
  end
end
