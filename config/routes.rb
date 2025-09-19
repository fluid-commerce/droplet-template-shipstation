Rails.application.routes.draw do
  root "home#index"

  devise_for :users

  post "webhook", to: "webhooks#create", as: :webhook
  post "webhook_test", to: "webhooks#test", as: :webhook_test

  namespace :admin do
    get "dashboard/index"
    resource :droplet, only: %i[ create update ]
    resources :settings, only: %i[ index edit update ]
    resources :users
    resources :callbacks, only: %i[ index show edit update ] do
      post :sync, on: :collection
    end
  end

  resources :integration_settings, only: %i[create]

  # API routes
  namespace :api do
    namespace :v1 do
      resources :orders, only: %i[create]
    end
  end

  get "up" => "rails/health#show", as: :rails_health_check
end
