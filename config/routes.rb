Rails.application.routes.draw do
  root "home#index"

  devise_for :users

  resources :webhooks, only: %i[create] do
    post "shipped", on: :collection
  end

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

  get "up" => "rails/health#show", as: :rails_health_check
end
